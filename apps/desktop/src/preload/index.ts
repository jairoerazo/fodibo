import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type FodiboApi } from '../shared/ipc.js';

const api: FodiboApi = {
  startReceiving: () => ipcRenderer.invoke(CHANNELS.start),
  stopReceiving: () => ipcRenderer.invoke(CHANNELS.stop),
  listReceived: () => ipcRenderer.invoke(CHANNELS.list),
  openPackage: (packageId) => ipcRenderer.invoke(CHANNELS.open, packageId),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event);
    ipcRenderer.on(CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('fodibo', api);
