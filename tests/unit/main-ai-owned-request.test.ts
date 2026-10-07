import { expect, test, vi } from "vitest";

import { DEFAULT_AI_ANALYSIS_SETTINGS } from "../../src/shared/ai-analysis-settings";
import { DEFAULT_AI_RELIABILITY_SETTINGS } from "../../src/shared/ai-reliability";
import { createPublicError } from "../../src/shared/protocol/errors";
import {
  tryHandleAiOwnedRequest,
  type AiOwnedConfig,
  type AiOwnedRequestRuntime,
} from "../../src/main/library-request/ai";

function config(overrides?: Partial<AiOwnedConfig>): AiOwnedConfig {
  return {
    hasKey: true,
    apiFormat: "openai_chat",
    model: "gpt-4o",
    baseUrl: "",
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS,
    concurrencyLimit: 2,
    maxAnalysisImageEdgePx: 2048,
    reliabilitySettings: DEFAULT_AI_RELIABILITY_SETTINGS,
    languages: ["zh-CN", "en"],
    autoAnalyzeEnabled: false,
    disclaimerAccepted: true,
    ...overrides,
  };
}

function runtime(overrides?: Partial<AiOwnedRequestRuntime>): AiOwnedRequestRuntime {
  return {
    loadAiConfig: () => config(),
    getDecryptedApiKey: () => "sk-test",
    saveAiConfig: vi.fn(),
    saveEncryptedApiKey: vi.fn(),
    workerAvailable: () => true,
    requestWorker: vi.fn(async () => ({
      ok: false as const,
      error: { code: "INTERNAL_ERROR" as const, message: "unused" },
    })),
    processAiQueue: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
    ...overrides,
  };
}

test("unrelated renderer requests fall through", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "folder.list.request", libraryId: "lib-1" },
    runtime(),
  )).resolves.toBeUndefined();
});

test("assets.analyze returns not-configured when the key is missing", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "assets.analyze.request",
      libraryId: "lib-1",
      assetIds: ["asset-1"],
    },
    runtime({
      loadAiConfig: () => config({ hasKey: false }),
    }),
  )).resolves.toMatchObject({
    ok: false,
    error: { code: "AI_ANALYSIS_FAILED", reason: "AI_NOT_CONFIGURED" },
  });
});

test("asset.analyze falls through when enqueue does not create a job", async () => {
  await expect(tryHandleAiOwnedRequest(
    {
      type: "asset.analyze.request",
      libraryId: "lib-1",
      assetId: "asset-1",
    },
    runtime({
      requestWorker: vi.fn(async () => ({
        ok: true as const,
        type: "ai.jobs.enqueued" as const,
        libraryId: "lib-1",
        jobIds: [],
        alreadyPendingJobIds: [],
        skippedAssetIds: ["asset-1"],
        enqueued: 0,
      })),
    }),
  )).resolves.toBeUndefined();
});

test.each(["LIBRARY_NOT_OPEN", "LIBRARY_READ_ONLY", "LIBRARY_BUSY"] as const)(
  "analysis preserves %s from queue admission rather than blaming the AI service",
  async (code) => {
    const failure = { ok: false as const, error: createPublicError(code) };
    for (const request of [
      { type: "assets.analyze.request" as const, libraryId: "lib-1", assetIds: ["asset-1"] },
      { type: "asset.analyze.request" as const, libraryId: "lib-1", assetId: "asset-1" },
    ]) {
      const state = runtime({ requestWorker: vi.fn(async () => failure) });
      await expect(tryHandleAiOwnedRequest(request, state)).resolves.toEqual(failure);
      expect(state.processAiQueue).not.toHaveBeenCalled();
      expect(state.requestWorker).toHaveBeenCalledTimes(1);
      expect(state.logInfo).toHaveBeenCalledWith(expect.any(String), expect.any(String),
        expect.objectContaining({ errorCode: code }));
    }
  },
);

test("a batch containing only skipped assets returns their IDs without running inference", async () => {
  const state = runtime({ requestWorker: vi.fn(async () => ({
    ok: true as const, type: "ai.jobs.enqueued" as const, libraryId: "lib-1",
    jobIds: [], alreadyPendingJobIds: [], skippedAssetIds: ["asset-1"], enqueued: 0,
  })) });
  await expect(tryHandleAiOwnedRequest({
    type: "assets.analyze.request", libraryId: "lib-1", assetIds: ["asset-1"],
  }, state)).resolves.toMatchObject({
    ok: true, type: "assets.analyze-queued", jobIds: [], skippedAssetIds: ["asset-1"],
  });
  expect(state.processAiQueue).not.toHaveBeenCalled();
});

test("ai.config.get maps the stored config onto the renderer payload", async () => {
  await expect(tryHandleAiOwnedRequest(
    { type: "ai.config.get.request" },
    runtime(),
  )).resolves.toMatchObject({
    ok: true,
    type: "ai.config.got",
    apiFormat: "openai_chat",
    model: "gpt-4o",
    hasKey: true,
  });
});

test("local connection probes do not require credentials or a responsive library Worker", async () => {
  const probeAiConnection = vi.fn(async () => ({ success: true }));
  const requestWorker = vi.fn(async () => { throw new Error('Worker blocked'); });
  await expect(tryHandleAiOwnedRequest({
    type: 'ai.test-connection.request', apiFormat: 'openai_responses',
    baseUrl: 'http://127.0.0.1:1234/v1', model: ' local-model ',
  }, runtime({ getDecryptedApiKey: () => { throw new Error('Unreadable key'); },
    workerAvailable: () => false, requestWorker, probeAiConnection,
  }))).resolves.toMatchObject({ ok: true, type: 'ai.test-connection.result', success: true });
  expect(requestWorker).not.toHaveBeenCalled();
  expect(probeAiConnection).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', model: 'local-model' }));
});

test("switching from keyless local AI to a remote provider still requires a decryptable key", async () => {
  const request = {
    type: 'ai.config.set.request' as const, apiFormat: 'openai_responses' as const,
    model: ' remote-model ', baseUrl: 'https://example.com/v1',
    autoAnalyzeEnabled: false, disclaimerAccepted: true,
  };
  const state = runtime({
    loadAiConfig: () => config({ baseUrl: 'http://127.0.0.1:1234/v1' }),
    getDecryptedApiKey: () => { throw new Error('Unreadable key'); },
    workerAvailable: () => false,
  });
  await expect(tryHandleAiOwnedRequest(request, state)).resolves.toMatchObject({
    ok: false, error: { code: 'AI_SETTINGS_INCOMPLETE' },
  });
  expect(state.saveAiConfig).not.toHaveBeenCalled();
  await expect(tryHandleAiOwnedRequest({ ...request, baseUrl: 'http://127.0.0.1:1234/v1', concurrencyLimit: 16 }, state)).resolves.toMatchObject({ ok: true });
  expect(state.saveAiConfig).toHaveBeenCalledWith(expect.objectContaining({ model: 'remote-model', concurrencyLimit: 2 }));
});

vi.mock("../../src/main/ai-credentials", async () => {
  const { resolveAiApiKey } = await import("../../src/shared/local-ai");
  return { resolveAiRequestKey: async (...args: Parameters<typeof resolveAiApiKey>) => resolveAiApiKey(...args) };
});
