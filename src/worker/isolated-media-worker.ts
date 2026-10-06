import { Worker } from 'node:worker_threads';

const activeWorkers = new Set<Worker>();

/** CPU-bound codecs must never run on the SQLite/IPC owner thread. */
export function runIsolatedMediaWorker<T>(
  source: string,
  workerData: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException('Media decode cancelled.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData, execArgv: [] });
    activeWorkers.add(worker);
    let result: { value: T } | undefined;
    let failure: Error | undefined;
    let stopping = false;
    const stop = (error: Error) => {
      if (stopping) return;
      stopping = true;
      failure = error;
      void worker.terminate();
    };
    const abort = () => stop(new DOMException('Media decode cancelled.', 'AbortError'));
    const timer = setTimeout(
      () => stop(new Error('PDF thumbnail decode exceeded its time limit.')),
      options.timeoutMs ?? 30_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: { value?: T; error?: string }) => {
      if (stopping) return;
      if (message.error) {
        stop(new Error(message.error));
      } else {
        result = { value: message.value as T };
      }
    });
    worker.on('error', (error) => { failure ??= error instanceof Error ? error : new Error(String(error)); });
    worker.once('exit', (code) => {
      activeWorkers.delete(worker);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      // Settle only after termination, so the caller can safely remove output
      // files without racing a cancelled thread that is still writing them.
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Media decoder exited without a result (${code}).`));
      else resolve(result.value);
    });
    if (options.signal?.aborted) abort();
  });
}

export async function shutdownIsolatedMediaWorkers(): Promise<void> {
  await Promise.all([...activeWorkers].map((worker) => worker.terminate()));
}
