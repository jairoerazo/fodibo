import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { AGENT_CHANNELS, type AgentApi } from '../shared/agent-ipc.js';
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

const agentApi: AgentApi = {
  openPortal: () => ipcRenderer.invoke(AGENT_CHANNELS.open),
  closePortal: () => ipcRenderer.invoke(AGENT_CHANNELS.close),
  start: () => ipcRenderer.invoke(AGENT_CHANNELS.start),
  stop: () => ipcRenderer.invoke(AGENT_CHANNELS.stop),
  setBounds: (r) => ipcRenderer.send(AGENT_CHANNELS.bounds, r),
  setVisible: (v) => ipcRenderer.send(AGENT_CHANNELS.visible, v),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event);
    ipcRenderer.on(AGENT_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(AGENT_CHANNELS.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('fodiboAgent', agentApi);
