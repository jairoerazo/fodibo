import type { AgentApi } from '../shared/agent-ipc.js';
import type { FodiboApi } from '../shared/ipc.js';

declare global {
  interface Window {
    fodibo: FodiboApi;
    fodiboAgent: AgentApi;
  }
}
