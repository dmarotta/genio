import { BrowserWindow } from 'electron'
import { THUMB_MAX_BYTES } from '@shared/inventory'
import type { ThumbnailDecoder } from './inventory'

/** Native Chromium codecs run in an isolated Web Worker, never on the main/UI thread.
 * A single hidden sandboxed window hosts it on demand; the service serializes jobs.
 * Models draw in their own hidden window (model-thumbnails.ts); DCC/HDR, video posters and waveforms are later work.
 */
export function createThumbnailDecoder(): { decode: ThumbnailDecoder; stop(): void } {
  let win: BrowserWindow | undefined, loading: Promise<void> | undefined
  const source = `onmessage = async ({data: url}) => {
    try {
      const response = await fetch(url);
      if (!response.ok || Number(response.headers.get('content-length')) > ${THUMB_MAX_BYTES}) throw Error('Unavailable or too large');
      const blob = await response.blob();
      if (blob.size > ${THUMB_MAX_BYTES}) throw Error('Too large');
      const bitmap = await createImageBitmap(blob);
      try {
        if (bitmap.width * bitmap.height > 64 * 1024 * 1024) throw Error('Too many pixels');
        const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const out = await canvas.convertToBlob({type:'image/webp', quality:0.8});
        const bytes = new Uint8Array(await out.arrayBuffer());
        postMessage(bytes, [bytes.buffer]);
      } finally { bitmap.close(); }
    } catch { postMessage(null); }
  }`
  return {
    async decode(url) {
      if (!win || win.isDestroyed()) {
        win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        loading = win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; script-src blob:; worker-src blob:; connect-src genio-media:">')
      }
      await loading
      const bytes: number[] | null = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const objectUrl = URL.createObjectURL(new Blob([${JSON.stringify(source)}], {type:'text/javascript'}));
        const worker = new Worker(objectUrl);
        const finish = value => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(objectUrl); resolve(value); };
        const timer = setTimeout(() => finish(null), 20000);
        worker.onmessage = e => finish(e.data ? Array.from(e.data) : null);
        worker.onerror = () => finish(null);
        worker.postMessage(${JSON.stringify(url)});
      })`)
      return bytes ? Buffer.from(bytes) : undefined
    },
    stop() { win?.destroy(); win = undefined; loading = undefined }
  }
}
