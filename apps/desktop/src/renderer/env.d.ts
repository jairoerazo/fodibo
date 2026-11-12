import type { AgentApi } from '../shared/agent-ipc.js';
import type { ExpedienteApi } from '../shared/expediente-ipc.js';
import type { FodiboApi } from '../shared/ipc.js';

declare global {
  interface Window {
    fodibo: FodiboApi;
    fodiboAgent: AgentApi;
    fodiboExpediente: ExpedienteApi;
  }
}

declare module '*?url' {
  const url: string;
  export default url;
}
