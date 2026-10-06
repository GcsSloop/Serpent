import { describe, expect, it } from 'vitest';
import { runIsolatedMediaWorker, shutdownIsolatedMediaWorkers } from '../../src/worker/isolated-media-worker';

const busyDecoder = `
  const { parentPort, workerData } = require('node:worker_threads');
  const start = Date.now();
  while (Date.now() - start < workerData.duration) {}
  parentPort.postMessage({ value: 'decoded' });
  parentPort.close();
`;

describe('isolated media decoding', () => {
  it('keeps the control event loop responsive during a CPU-bound decode', async () => {
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 10);
    try {
      const result = await runIsolatedMediaWorker(busyDecoder, { duration: 400 });
      expect(result).toBe('decoded');
      expect(heartbeats).toBeGreaterThan(10);
    } finally { clearInterval(timer); }
  });

  it('terminates a busy decoder promptly when a user operation cancels it', async () => {
    const controller = new AbortController();
    const result = runIsolatedMediaWorker(busyDecoder, { duration: 60_000 }, { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    controller.abort();
    await assertion;
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('bounds decoder runtime and drains active workers during shutdown', async () => {
    await expect(runIsolatedMediaWorker(busyDecoder, { duration: 60_000 }, { timeoutMs: 100 }))
      .rejects.toThrow('time limit');
    const pending = runIsolatedMediaWorker(busyDecoder, { duration: 60_000 });
    const assertion = expect(pending).rejects.toThrow('without a result');
    await shutdownIsolatedMediaWorkers();
    await assertion;
  });
});
