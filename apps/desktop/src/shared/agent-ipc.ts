import type { AgentEvent } from '../core/agent/index.js';

export const AGENT_CHANNELS = {
  open: 'agent:open',
  close: 'agent:close',
  start: 'agent:start',
  stop: 'agent:stop',
  bounds: 'agent:bounds',
  event: 'agent:event',
} as const;

export type AgentUiEvent =
  | AgentEvent
  | { type: 'model'; status: 'arrancando' | 'listo' | 'error'; message?: string };

export interface AgentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentApi {
  openPortal(): Promise<void>;
  closePortal(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setBounds(r: AgentBounds): void;
  /** Devuelve la función que cancela la suscripción. */
  onEvent(cb: (e: AgentUiEvent) => void): () => void;
}
