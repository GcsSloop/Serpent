import type { AiApiFormat } from './ai-endpoints';
import { normalizeAiAnalysisConcurrency } from './ai-concurrency';

export type AiEndpointConfig = { apiFormat?: AiApiFormat; baseUrl?: string | null };

/** Only an explicit HTTP(S) loopback OpenAI endpoint may omit credentials. */
export function isLocalOpenAiEndpoint(config: AiEndpointConfig): boolean {
  if (config.apiFormat !== 'openai_chat' && config.apiFormat !== 'openai_responses') return false;
  try {
    const url = new URL(config.baseUrl?.trim() ?? '');
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function resolveAiApiKey(
  config: AiEndpointConfig,
  typedKey: string | undefined,
  readStoredKey: () => string,
): string {
  if (typedKey?.trim()) return typedKey.trim();
  // Never enter synchronous Keychain APIs for a keyless loopback service.
  // Main's async resolver checks whether authentication is actually required.
  if (isLocalOpenAiEndpoint(config)) return '';
  const stored = readStoredKey().trim();
  if (!stored) throw new Error('AI API key is not configured.');
  return stored;
}

export function normalizeEndpointAiConcurrency(config: AiEndpointConfig, raw: unknown): number {
  const limit = normalizeAiAnalysisConcurrency(raw);
  return isLocalOpenAiEndpoint(config) ? Math.min(2, limit) : limit;
}

export type AiReasoningMode = 'auto' | 'service_default' | 'off';

export function openAiInferenceOptions(
  config: AiEndpointConfig,
  mode: AiReasoningMode = 'auto',
): Record<string, unknown> {
  const disableThinking = mode === 'off' || (mode === 'auto' && isLocalOpenAiEndpoint(config));
  if (!disableThinking) return {};
  return config.apiFormat === 'openai_responses'
    ? { reasoning: { effort: 'none' }, max_output_tokens: 2048 }
    : { reasoning_effort: 'none', max_tokens: 2048 };
}
