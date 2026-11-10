/**
 * GUPPY-BLOB-P01: the blob overlay's OWN preload. Deliberately narrow: it exposes only the
 * `blob:overlay:*` channels (main also gates each on the sender being the overlay's top frame) and
 * nothing of the app's `cth` API, so the overlay cannot write to a terminal, deliver a message,
 * read config or change its own settings.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BlobOverlayApi, BlobOverlayStatus } from '../shared/blob';

const blobApi: BlobOverlayApi = {
  status: () => ipcRenderer.invoke('blob:overlay:status'),
  action: (slot) => ipcRenderer.invoke('blob:overlay:action', slot),
  ring: (open) => ipcRenderer.invoke('blob:overlay:ring', open),
  drag: (phase) => ipcRenderer.invoke('blob:overlay:drag', phase),
  onStatus: (cb) => {
    const fn = (_e: IpcRendererEvent, s: BlobOverlayStatus): void => cb(s);
    ipcRenderer.on('blob:status', fn);
    return () => { ipcRenderer.removeListener('blob:status', fn); };
  },
};

contextBridge.exposeInMainWorld('blob', blobApi);
