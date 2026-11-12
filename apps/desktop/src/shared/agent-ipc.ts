import type { AgentEvent } from '../core/agent/index.js';

export const AGENT_CHANNELS = {
  open: 'agent:open',
  close: 'agent:close',
  start: 'agent:start',
  stop: 'agent:stop',
  bounds: 'agent:bounds',
  visible: 'agent:visible',
  event: 'agent:event',
} as const;

export type AgentUiEvent =
  | AgentEvent
  | { type: 'model'; status: 'arrancando' | 'listo' | 'error'; message?: string }
  /** Versión aprobada con la que se rellena el portal; se emite justo después de cargarla. */
  | { type: 'declaration'; caseId: string; caseRevision: number; approvedAt: string; contentHash: string };

export interface AgentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentApi {
  openPortal(): Promise<void>;
  closePortal(): Promise<void>;
  /** Rellena el portal con la versión aprobada del expediente `caseId`. */
  start(caseId: string): Promise<void>;
  stop(): Promise<void>;
  setBounds(r: AgentBounds): void;
  /** Muestra u oculta la vista del portal sin cambiar su tamaño (sigue funcionando oculta). */
  setVisible(visible: boolean): void;
  /** Devuelve la función que cancela la suscripción. */
  onEvent(cb: (e: AgentUiEvent) => void): () => void;
}
