import { describe, expect, it, vi } from 'vitest';
import { isLocalOpenAiEndpoint, normalizeEndpointAiConcurrency, resolveAiApiKey } from '../../src/shared/local-ai';
import { resolveAiRequestKey } from '../../src/main/ai-credentials';
import { AiConnectionProbe } from '../../src/main/ai-connection-probe';
import { OpenAIVendorAdapter } from '../../src/worker/ai/openai-adapter';
import { DEFAULT_AI_ANALYSIS_SETTINGS } from '../../src/shared/ai-analysis-settings';
import { workerCommandSchema } from '../../src/shared/protocol/requests';

const local = { apiFormat: 'openai_responses' as const, baseUrl: 'http://127.0.0.1:1234/v1' };
const model = 'gcssloop/qwen3.8-27b-uncensored';
const image = {
  displayName: 'red.png', filename: 'red.png', mime: 'image/png', imageBase64: 'AA==',
  language: 'zh-CN', enabledFields: { description: true, tags: true, rating: true },
  existingTagNames: [], analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
};
const reply = { model, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"description":"红色", "tags":["红色"], "rating":3}' }] }] };

it.each(['openai_chat', 'openai_responses'] as const)('sends a bounded document preview with explicit page scope via %s', async (format) => {
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json(format === 'openai_chat'
    ? { model, choices: [{ message: { content: '{"description":"红色页面","tags":["文档"],"rating":3}' } }] }
    : reply));
  const adapter = new OpenAIVendorAdapter('', model, fetchFn as typeof fetch, local.baseUrl, format);
  await adapter.analyze({ ...image, filename: 'page.pdf', displayName: 'page.pdf',
    mime: 'image/jpeg', mediaType: 'document', visualSourceDescription: 'Only the first page is visible.' });
  const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
  const serialized = JSON.stringify(body);
  expect(serialized).toContain('Only the first page is visible.');
  expect(serialized).toContain('不要将其描述为已阅读整个文档');
  expect(serialized).toContain('data:image/jpeg;base64,AA==');
  expect(serialized).not.toContain('data:application/pdf');
});

describe('local AI compatibility', () => {
  it('only allows missing or unreadable credentials on explicit loopback OpenAI URLs', () => {
    const unreadable = vi.fn(() => { throw new Error('Keychain failure'); });
    expect(resolveAiApiKey(local, undefined, unreadable)).toBe('');
    expect(unreadable).not.toHaveBeenCalled();
    for (const baseUrl of ['', 'https://example.com/v1', 'http://127.0.0.1.example.com/v1', 'http://localhost@evil.example/v1']) {
      expect(isLocalOpenAiEndpoint({ ...local, baseUrl })).toBe(false);
      expect(() => resolveAiApiKey({ ...local, baseUrl }, undefined, unreadable)).toThrow('Keychain failure');
    }
    expect(isLocalOpenAiEndpoint({ ...local, baseUrl: 'http://[::1]:1234/v1' })).toBe(true);
    expect(resolveAiApiKey(local, ' real-local-key ', unreadable)).toBe('real-local-key');
    expect(normalizeEndpointAiConcurrency(local, 16)).toBe(2);
    expect(normalizeEndpointAiConcurrency({ ...local, baseUrl: '' }, 16)).toBe(16);
  });

  it('probes reachability without inference, trims models and coalesces overlapping requests', async () => {
    let release!: () => void;
    const fetchFn = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({ data: [{ id: model }] });
    });
    const probe = new AiConnectionProbe(fetchFn as typeof fetch);
    const input = { ...local, model: ` ${model} `, apiKey: '', probeMode: 'reachability' as const };
    const first = probe.run(input);
    const second = probe.run(input);
    expect(first).toBe(second);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ success: true });
    expect(fetchFn.mock.calls[0]).toMatchObject([expect.stringContaining('/models'), { method: 'GET' }]);
  });

  it('rejects a missing model and a reasoning-only inference response', async () => {
    const probe = new AiConnectionProbe(vi.fn(async () => Response.json({ data: [] })) as typeof fetch);
    await expect(probe.run({ ...local, model, apiKey: '', probeMode: 'reachability' })).resolves.toMatchObject({ success: false, errorKind: 'invalid_response' });
    const adapter = new OpenAIVendorAdapter('', model, vi.fn(async () => Response.json({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking' }] }] })) as typeof fetch, local.baseUrl, 'openai_responses');
    await expect(adapter.probeConnection()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('local image analysis disables thinking without sending empty bearer credentials', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      expect(init?.headers).not.toHaveProperty('Authorization');
      return Response.json(reply);
    }) as typeof fetch;
    const adapter = new OpenAIVendorAdapter('', ` ${model} `, fetchFn, local.baseUrl, 'openai_responses');
    await expect(adapter.analyze(image)).resolves.toMatchObject({ description: '红色', tags: ['红色'], rating: 3 });
    expect(bodies[0]).toMatchObject({ model, reasoning: { effort: 'none' }, max_output_tokens: 2048 });
    const providerDefault = new OpenAIVendorAdapter('', model, fetchFn, local.baseUrl, 'openai_responses');
    await providerDefault.analyze({ ...image, analysisSettings: { ...DEFAULT_AI_ANALYSIS_SETTINGS, reasoningMode: 'service_default' } });
    expect(bodies.at(-1)).not.toHaveProperty('reasoning');
  });

  it('retries unsupported reasoning controls but preserves unrelated HTTP errors', async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = new OpenAIVendorAdapter('', model, (async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      return body.reasoning
        ? Response.json({ error: { message: 'Unsupported parameter reasoning.effort', param: 'reasoning.effort' } }, { status: 400 })
        : Response.json(reply);
    }) as typeof fetch, local.baseUrl, 'openai_responses');
    await expect(adapter.analyze(image)).resolves.toMatchObject({ tags: ['红色'] });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('reasoning');
    const rejected = vi.fn(async () => Response.json({ error: { message: 'Invalid image input', param: 'input_image' } }, { status: 400 }));
    await expect(new OpenAIVendorAdapter('', model, rejected as typeof fetch, local.baseUrl, 'openai_responses').analyze(image)).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('private-channel empty credentials are accepted only for local services', () => {
    const command = { type: 'ai.test-connection', ...local, model, apiKey: '' };
    expect(workerCommandSchema.safeParse(command).success).toBe(true);
    expect(workerCommandSchema.safeParse({ ...command, baseUrl: 'https://example.com/v1' }).success).toBe(false);
  });
});

it('never reads Keychain for unauthenticated or unreachable local servers, but supports authenticated local servers', async () => {
  const readKey = vi.fn(() => 'local-auth-key');
  const noAuth = vi.fn(async () => Response.json({ data: [] }));
  await expect(resolveAiRequestKey(local, undefined, readKey, noAuth as typeof fetch)).resolves.toBe('');
  expect(readKey).not.toHaveBeenCalled();
  await expect(resolveAiRequestKey(local, undefined, readKey, vi.fn(async () => { throw new Error('offline'); }) as typeof fetch)).resolves.toBe('');
  expect(readKey).not.toHaveBeenCalled();
  await expect(resolveAiRequestKey(local, undefined, readKey, vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch)).resolves.toBe('local-auth-key');
  expect(readKey).toHaveBeenCalledTimes(1);
  const typedFetch = vi.fn(async () => Response.json({}));
  await expect(resolveAiRequestKey(local, 'typed-key', readKey, typedFetch as typeof fetch)).resolves.toBe('typed-key');
  expect(typedFetch).not.toHaveBeenCalled();
});
