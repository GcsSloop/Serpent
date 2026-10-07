import { createHash } from 'node:crypto';
import { listAiModels, type AiApiFormat } from '../shared/ai-endpoints';
import { isLocalOpenAiEndpoint } from '../shared/local-ai';
import { OpenAIVendorAdapter } from '../worker/ai/openai-adapter';
import { AnthropicVendorAdapter } from '../worker/ai/anthropic-adapter';
import { GeminiVendorAdapter } from '../worker/ai/gemini-adapter';
import { DashScopeVendorAdapter } from '../worker/ai/dashscope-adapter';
import { safeAiConnectionFailure } from '../worker/ai/error-mapping';

export type AiConnectionProbeInput = {
  apiFormat: AiApiFormat;
  model: string;
  apiKey: string;
  baseUrl?: string;
  probeMode?: 'inference' | 'reachability';
};
export type AiConnectionProbeResult = { success: boolean; errorKind?: string; reason?: string };

/** Network-only requests belong in Main, independently of the library scheduler. */
export class AiConnectionProbe {
  private readonly pending = new Map<string, Promise<AiConnectionProbeResult>>();

  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  run(input: AiConnectionProbeInput): Promise<AiConnectionProbeResult> {
    const normalized = { ...input, model: input.model.trim(), baseUrl: input.baseUrl?.trim() };
    // Coalesce identical probes without retaining plaintext credentials in keys.
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const existing = this.pending.get(fingerprint);
    if (existing) return existing;
    const result = this.probe(normalized).finally(() => this.pending.delete(fingerprint));
    this.pending.set(fingerprint, result);
    return result;
  }

  private async probe(input: AiConnectionProbeInput): Promise<AiConnectionProbeResult> {
    try {
      if (input.probeMode === 'reachability' && isLocalOpenAiEndpoint(input)) {
        const listed = await listAiModels({ ...input, fetchFn: this.fetchFn, signal: AbortSignal.timeout(10_000) });
        if (!listed.ok) return { success: false, errorKind: listed.errorKind, reason: listed.reason };
        if (!listed.models.includes(input.model)) {
          return { success: false, errorKind: 'invalid_response', reason: 'The configured model is not available from the local AI service.' };
        }
        return { success: true };
      }
      const { apiFormat, apiKey, model, baseUrl } = input;
      const adapter = apiFormat === 'openai_chat' || apiFormat === 'openai_responses'
        ? new OpenAIVendorAdapter(apiKey, model, this.fetchFn, baseUrl, apiFormat)
        : apiFormat === 'anthropic'
          ? new AnthropicVendorAdapter(apiKey, model, this.fetchFn, baseUrl)
          : apiFormat === 'gemini_native'
            ? new GeminiVendorAdapter(apiKey, model, this.fetchFn, baseUrl)
            : new DashScopeVendorAdapter(apiKey, model, this.fetchFn, baseUrl);
      // Local model loading can exceed the former fixed 15-second budget.
      await adapter.probeConnection(AbortSignal.timeout(120_000));
      return { success: true };
    } catch (error) {
      return { success: false, ...safeAiConnectionFailure(error) };
    }
  }
}
