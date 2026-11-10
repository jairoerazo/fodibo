import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TransferError } from './errors.js';

const SECRET_TTL_MS = 5 * 60_000;
const INACTIVITY_MS = 30 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export type CloseReason = 'stopped' | 'too-many-attempts' | 'inactive';

export class PairingSession {
  readonly secret: string = randomBytes(16).toString('base64url');
  readonly expiresAt: Date;
  private readonly now: () => number;
  private token: string | undefined;
  private secretUsed = false;
  private failed = 0;
  private lastActivity = 0;
  private isClosed = false;
  private readonly closeCallbacks: Array<(reason: CloseReason) => void> = [];

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.expiresAt = new Date(this.now() + SECRET_TTL_MS);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  pair(secret: string, _deviceName: string): { sessionToken: string } {
    const valid =
      !this.isClosed &&
      !this.secretUsed &&
      this.now() <= this.expiresAt.getTime() &&
      safeEqual(secret, this.secret);
    if (!valid) {
      // Una vez usado el secreto, los intentos fallidos ya no pueden cerrar la sesión emparejada.
      if (!this.isClosed && !this.secretUsed && ++this.failed >= MAX_FAILED_ATTEMPTS) {
        this.close('too-many-attempts');
      }
      throw new TransferError('invalid_secret');
    }
    this.secretUsed = true;
    this.token = randomBytes(32).toString('base64url');
    this.lastActivity = this.now();
    return { sessionToken: this.token };
  }

  authenticate(token: string | undefined): void {
    if (this.isClosed || this.token === undefined || token === undefined || !safeEqual(token, this.token)) {
      throw new TransferError('unauthorized');
    }
    this.checkIdle();
    if (this.isClosed) throw new TransferError('unauthorized');
    this.lastActivity = this.now();
  }

  /** Cierra la sesión emparejada si lleva más de 30 min sin peticiones autenticadas. */
  checkIdle(): void {
    if (this.isClosed || this.token === undefined) return;
    if (this.now() - this.lastActivity > INACTIVITY_MS) this.close('inactive');
  }

  close(reason: CloseReason = 'stopped'): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.token = undefined;
    for (const cb of this.closeCallbacks) cb(reason);
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeCallbacks.push(cb);
  }
}
