import type { ReceivedPackage, TransferEvent } from '../core/transfer/index.js';

export const CHANNELS = {
  start: 'transfer:start',
  stop: 'transfer:stop',
  list: 'transfer:list',
  open: 'transfer:open',
  event: 'transfer:event',
} as const;

export interface FodiboApi {
  startReceiving(): Promise<{ qrDataUrl: string; expiresAt: string }>;
  stopReceiving(): Promise<void>;
  listReceived(): Promise<ReceivedPackage[]>;
  openPackage(packageId: string): Promise<void>;
  /** Devuelve la función que cancela la suscripción. */
  onEvent(cb: (e: TransferEvent) => void): () => void;
}
