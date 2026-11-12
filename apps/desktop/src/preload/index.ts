import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { AGENT_CHANNELS, type AgentApi } from '../shared/agent-ipc.js';
import { CASE_CHANNELS, type ExpedienteApi } from '../shared/expediente-ipc.js';
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
  start: (caseId) => ipcRenderer.invoke(AGENT_CHANNELS.start, caseId),
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

const expedienteApi: ExpedienteApi = {
  listCases: () => ipcRenderer.invoke(CASE_CHANNELS.list),
  createCase: (input) => ipcRenderer.invoke(CASE_CHANNELS.create, input),
  updateCase: (caseId, input) => ipcRenderer.invoke(CASE_CHANNELS.update, caseId, input),
  getCase: (caseId) => ipcRenderer.invoke(CASE_CHANNELS.get, caseId),
  listConcepts: () => ipcRenderer.invoke(CASE_CHANNELS.concepts),
  listImportable: () => ipcRenderer.invoke(CASE_CHANNELS.importable),
  importPackage: (caseId, packageId) => ipcRenderer.invoke(CASE_CHANNELS.import, caseId, packageId),
  setDocument: (documentId, patch) => ipcRenderer.invoke(CASE_CHANNELS.setDocument, documentId, patch),
  saveField: (caseId, input) => ipcRenderer.invoke(CASE_CHANNELS.saveField, caseId, input),
  deleteField: (fieldId) => ipcRenderer.invoke(CASE_CHANNELS.deleteField, fieldId),
  fieldHistory: (fieldId) => ipcRenderer.invoke(CASE_CHANNELS.fieldHistory, fieldId),
  approve: (caseId, expectedRevision) => ipcRenderer.invoke(CASE_CHANNELS.approve, caseId, expectedRevision),
  showDocumentInFolder: (documentId) => ipcRenderer.invoke(CASE_CHANNELS.showDocument, documentId),
  onEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event);
    ipcRenderer.on(CASE_CHANNELS.event, listener);
    return () => {
      ipcRenderer.removeListener(CASE_CHANNELS.event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('fodiboExpediente', expedienteApi);
