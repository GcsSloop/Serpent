import { createRequire } from 'node:module';
import path from 'node:path';

import { runIsolatedMediaWorker } from './isolated-media-worker';

// Resolve dependencies in the owning bundle, then load their original files
// inside the decoder. In particular, pdfjs needs its original import.meta.url
// for fonts, WASM and the fake worker; bundling it into the DB owner breaks that.
const moduleRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

const PDF_THUMBNAIL_THREAD = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readFile, stat } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
Object.defineProperty(process, 'type', { value: undefined, configurable: true });
(async () => {
  const { createCanvas, DOMMatrix, DOMPoint, DOMRect, Path2D, ImageData } = require(workerData.canvasModule);
  Object.assign(globalThis, { DOMMatrix, DOMPoint, DOMRect, Path2D, ImageData });
  const pdfjs = await import(pathToFileURL(workerData.pdfModule).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerData.pdfWorkerModule).href;
  class CanvasFactory {
    create(width, height) {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(target, width, height) { target.canvas.width = width; target.canvas.height = height; }
    destroy(target) { target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null; }
  }
  const data = new Uint8Array(await readFile(workerData.assetPath));
  if (!data.length) throw new Error('PDF file is empty.');
  const task = pdfjs.getDocument({
    data, CanvasFactory,
    wasmUrl: workerData.pdfRoot + '/wasm/',
    cMapUrl: workerData.pdfRoot + '/cmaps/',
    standardFontDataUrl: workerData.pdfRoot + '/standard_fonts/',
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale: longest > 0 ? 1024 / longest : 1 });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = createCanvas(width, height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const sharp = require(workerData.sharpModule);
    sharp.concurrency(1);
    await sharp(canvas.toBuffer('image/png')).rotate().toColourspace('srgb')
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72 }).toFile(workerData.outputPath);
    const metadata = await sharp(workerData.outputPath).metadata();
    return { width: metadata.width, height: metadata.height,
      byteSize: (await stat(workerData.outputPath)).size, generatorVersion: 'pdfjs@' + pdfjs.version };
  } finally { await task.destroy(); }
})().then(value => { parentPort.postMessage({ value }); parentPort.close(); },
  error => { parentPort.postMessage({ error: String(error?.message || error) }); parentPort.close(); });
`;

export function renderPdfThumbnail(
  assetPath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; byteSize: number; generatorVersion: string }> {
  return runIsolatedMediaWorker(PDF_THUMBNAIL_THREAD, {
    assetPath,
    outputPath,
    canvasModule: moduleRequire.resolve('@napi-rs/canvas'),
    sharpModule: moduleRequire.resolve('sharp'),
    pdfModule: moduleRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
    pdfWorkerModule: moduleRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    pdfRoot: path.dirname(moduleRequire.resolve('pdfjs-dist/package.json')),
  }, { signal });
}
