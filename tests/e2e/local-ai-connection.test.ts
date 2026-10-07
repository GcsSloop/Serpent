import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import sharp from 'sharp';
import type { SerpentLibraryApi as LibraryApi } from '../../src/shared/library-api';
import { assetCard, electronLaunchEnv, openAppSettingsDialog } from './electron-test-helpers';

test('packaged app saves keyless local AI settings and repeatedly analyzes with Qwen', async () => {
  test.setTimeout(240_000);
  const executablePath = process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  const baseUrl = process.env.SERPENT_E2E_LOCAL_AI_URL;
  test.skip(!executablePath || !baseUrl, 'Opt-in live local-model acceptance test');
  const model = process.env.SERPENT_E2E_LOCAL_AI_MODEL ?? 'gcssloop/qwen3.8-27b-uncensored';
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-local-ai-'));
  const userData = path.join(root, 'user-data');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'ai-config.json'), JSON.stringify({
    apiFormat: 'openai_responses', model: ` ${model} `, baseUrl,
    concurrencyLimit: 16, languages: ['zh-CN'], autoAnalyzeEnabled: false, disclaimerAccepted: true,
  }));
  // Reproduce an existing but unreadable key without touching the user's profile.
  writeFileSync(path.join(userData, 'ai-key.enc'), 'invalid-key-record');
  const sources = [path.join(root, 'red.png'), path.join(root, 'green.png')] as const;
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#ff0000' } }).png().toFile(sources[0]);
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#00ff00' } }).png().toFile(sources[1]);
  const unsupportedSource = path.join(root, 'unsupported.txt');
  writeFileSync(unsupportedSource, 'An unsupported visual-analysis source');
  const app = await electron.launch({ executablePath, args: [], env: electronLaunchEnv({
    SERPENT_E2E: '1', SERPENT_E2E_USER_DATA_PATH: userData,
  }) });
  const report: Record<string, unknown> = { model, baseUrl, measurements: [] };
  try {
    await app.evaluate(({ dialog }, input) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { title?: string };
        const create = options.title === 'Create Library' || options.title === '创建资源库';
        return { canceled: false, filePaths: create ? [input.root] : [...input.sources, input.unsupportedSource] };
      };
    }, { root, sources, unsupportedSource });
    const window = await app.firstWindow();
    window.setDefaultTimeout(20_000);
    window.on('pageerror', (error) => console.log('test renderer error:', error.message));
    console.log('test stage: create library');
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByRole('heading', { name: '创建本地资源库' })).toBeVisible({ timeout: 30_000 });
    const admissionError = await window.evaluate(() => {
      const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
      return api.analyzeAssets({ libraryId: 'not-open', assetIds: ['asset-1'] });
    });
    expect(admissionError).toMatchObject({ ok: false, error: { code: 'LIBRARY_NOT_OPEN' } });
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称' }).fill('Local AI Acceptance');
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await window.getByRole('button', { name: '导入文件', exact: true }).first().click();
    await expect(assetCard(window, 'red.png')).toBeVisible();
    await expect(assetCard(window, 'green.png')).toBeVisible();
    const unsupported = assetCard(window, 'unsupported.txt');
    await expect(unsupported).toBeVisible();
    const skipped = await window.evaluate(async (assetId) => {
      const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
      const libraries = await api.listOpen();
      if (!libraries.ok || !assetId) throw new Error('Missing test asset');
      return api.analyzeAssets({ libraryId: libraries.value[0]!.libraryId, assetIds: [assetId] });
    }, await unsupported.getAttribute('data-asset-id'));
    expect(skipped).toMatchObject({ ok: true, value: { jobIds: [], enqueued: 0 } });
    if (skipped.ok) expect(skipped.value.skippedAssetIds).toHaveLength(1);
    report.admissionError = admissionError;
    report.skippedUnsupportedAsset = skipped;

    console.log('test stage: AI settings');
    const dialog = await openAppSettingsDialog(app, window);
    await dialog.getByRole('tab', { name: 'AI分析', exact: true }).click();
    await expect(dialog.locator('#ai-config-model')).toHaveValue(model);
    await expect(dialog.locator('#ai-config-api-key')).toHaveValue('');
    await expect(dialog.locator('#ai-config-concurrency-limit')).toHaveValue('2');
    console.log('test stage: save keyless settings');
    await dialog.getByRole('button', { name: /保存|aiConfig\.save/ }).click();
    await expect(dialog.locator('.ai-connection-label')).toHaveText('已连接', { timeout: 120_000 });
    for (let i = 0; i < 2; i += 1) {
      await dialog.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(dialog.locator('.ai-connection-label')).toHaveText('已连接', { timeout: 120_000 });
    }
    await dialog.press('Escape');
    await expect(dialog).toBeHidden();
    const saved = JSON.parse(readFileSync(path.join(userData, 'ai-config.json'), 'utf8'));
    expect(saved.model).toBe(model);
    expect(saved.concurrencyLimit).toBe(2);
    expect(saved.analysisSettings.reasoningMode).toBe('auto');
    report.savedConfig = { model: saved.model, concurrencyLimit: saved.concurrencyLimit, reasoningMode: saved.analysisSettings.reasoningMode };

    // Real UI analysis, first edit followed by a second file and repeat analysis.
    let completed = 0;
    for (const filename of ['red.png', 'green.png', 'red.png']) {
      completed += 1;
      const card = assetCard(window, filename);
      await card.click();
      await card.click({ button: 'right' });
      console.log('test stage: analyze', filename);
      const started = Date.now();
      await window.getByRole('menuitem', { name: 'AI 分析', exact: true }).click();
      const probes = await window.evaluate(async (input) => {
        const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
        const start = performance.now();
        const replies = await Promise.all(Array.from({ length: 3 }, () => api.testAiConnection({
          apiFormat: 'openai_responses', model: input.model, baseUrl: input.baseUrl, probeMode: 'reachability',
        })));
        globalThis.dispatchEvent(new Event('focus'));
        return { milliseconds: performance.now() - start, replies };
      }, { model, baseUrl: baseUrl! });
      for (const reply of probes.replies) expect(reply).toMatchObject({ ok: true, value: { success: true } });
      expect(probes.milliseconds).toBeLessThan(5000);
      await expect.poll(async () => window.evaluate(async (expected) => {
        const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
        const libraries = await api.listOpen();
        if (!libraries.ok) return false;
        const status = await api.getAiJobStatus({ libraryId: libraries.value[0]!.libraryId });
        if (!status.ok) return false;
        return status.value.running === 0 && status.value.queued === 0 && status.value.failed === 0 && status.value.succeeded >= expected;
      }, completed), { timeout: 120_000, intervals: [250, 500, 1000] }).toBe(true);
      await expect(window.locator('.inspector-pane #meta-desc')).not.toHaveValue('');
      const content = await window.evaluate(async (assetId) => {
        const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
        const libraries = await api.listOpen();
        if (!libraries.ok || !assetId) throw new Error('Missing test asset');
        return api.getAiContent({ libraryId: libraries.value[0]!.libraryId, assetId });
      }, await card.getAttribute('data-asset-id'));
      expect(content.ok).toBe(true);
      if (!content.ok) throw new Error('Analysis not persisted');
      expect(content.value.modelVersion).toBe(model);
      expect(content.value.description).toBeTruthy();
      expect(content.value.tags.length).toBeGreaterThan(0);
      expect(content.value.rating).toBeGreaterThanOrEqual(1);
      (report.measurements as unknown[]).push({ filename, analysisMs: Date.now() - started, probeMs: probes.milliseconds, content: content.value });
    }
    await window.screenshot({ path: test.info().outputPath('qwen-local-ai.png') });
    report.success = true;
  } finally {
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        app.close(),
        new Promise<void>((resolve) => {
          shutdownTimer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 10_000);
        }),
      ]);
    } finally { clearTimeout(shutdownTimer); }
    const reportPath = process.env.SERPENT_LOCAL_AI_REPORT_PATH ?? test.info().outputPath('local-ai-report.json');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    rmSync(root, { recursive: true, force: true });
  }
});

test('keyless local AI cold starts twice without decrypting an old key', async () => {
  test.setTimeout(120_000);
  const executablePath = process.env.SERPENT_E2E_PACKAGED_EXECUTABLE;
  const baseUrl = process.env.SERPENT_E2E_LOCAL_AI_URL;
  test.skip(!executablePath || !baseUrl, 'Opt-in live local-model cold-start test');
  const model = process.env.SERPENT_E2E_LOCAL_AI_MODEL ?? 'gcssloop/qwen3.8-27b-uncensored';
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-local-ai-cold-'));
  const userData = path.join(root, 'profile');
  mkdirSync(userData);
  writeFileSync(path.join(userData, 'ai-config.json'), JSON.stringify({
    apiFormat: 'openai_responses', model, baseUrl, concurrencyLimit: 16,
    languages: ['zh-CN'], autoAnalyzeEnabled: false, disclaimerAccepted: true,
  }));
  writeFileSync(path.join(userData, 'ai-key.enc'), 'invalid-key-record');
  try {
    for (let launch = 0; launch < 2; launch += 1) {
      const app = await electron.launch({ executablePath, args: [], env: electronLaunchEnv({
        SERPENT_E2E: '1', SERPENT_E2E_USER_DATA_PATH: userData,
      }) });
      try {
        await app.evaluate(({ safeStorage }) => {
          const state = globalThis as typeof globalThis & { __serpentDecryptCount: number };
          state.__serpentDecryptCount = 0;
          const original = safeStorage.decryptString.bind(safeStorage);
          safeStorage.decryptString = (bytes) => { state.__serpentDecryptCount += 1; return original(bytes); };
        });
        const window = await app.firstWindow();
        await expect(window.getByRole('heading', { name: '创建本地资源库' })).toBeVisible({ timeout: 30_000 });
        const result = await window.evaluate(async (input) => {
          const api = (globalThis as typeof globalThis & { serpent: { library: LibraryApi } }).serpent.library;
          return api.testAiConnection({ apiFormat: 'openai_responses', ...input, probeMode: 'reachability' });
        }, { model, baseUrl: baseUrl! });
        expect(result).toMatchObject({ ok: true, value: { success: true } });
        expect(await app.evaluate(() => (globalThis as typeof globalThis & { __serpentDecryptCount: number }).__serpentDecryptCount)).toBe(0);
      } finally {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([app.close(), new Promise<void>((resolve) => {
            timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 10_000);
          })]);
        } finally { clearTimeout(timer); }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
