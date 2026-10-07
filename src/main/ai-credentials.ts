import { resolveOpenAiModelsUrl } from '../shared/ai-endpoints';
import { isLocalOpenAiEndpoint, resolveAiApiKey, type AiEndpointConfig } from '../shared/local-ai';

const pendingAuthChecks = new Map<string, Promise<boolean>>();

/** Do not block Main on Keychain access when a local server needs no key. */
export async function resolveAiRequestKey(
  config: AiEndpointConfig,
  typedKey: string | undefined,
  readStoredKey: () => string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  if (typedKey?.trim() || !isLocalOpenAiEndpoint(config)) {
    return resolveAiApiKey(config, typedKey, readStoredKey);
  }
  const url = resolveOpenAiModelsUrl(config.apiFormat === 'openai_responses' ? 'openai_responses' : 'openai_chat', config.baseUrl);
  let check = pendingAuthChecks.get(url);
  if (!check) {
    check = (async () => {
      try {
        const response = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
        const required = response.status === 401 || response.status === 403;
        await response.body?.cancel().catch(() => {});
        return required;
      } catch {
        // The real probe/analysis reports transport errors. They must never
        // trigger an unrelated synchronous OS credential prompt.
        return false;
      }
    })().finally(() => pendingAuthChecks.delete(url));
    pendingAuthChecks.set(url, check);
  }
  if (!await check) return '';
  const key = readStoredKey().trim();
  if (!key) throw new Error('The local AI service requires an API key.');
  return key;
}
