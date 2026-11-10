import { join } from 'node:path';
import { loadOrCreateCertificate } from './certificate.js';
import { TransferError, type ErrorCode } from './errors.js';
import { Inbox } from './inbox.js';
import { privateIPv4Addresses } from './network.js';
import { TransferServer } from './server.js';
import { PairingSession, type CloseReason } from './session.js';
import type { ReceivedPackage } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDLE_CHECK_MS = 60_000;

export type QrPayload = { v: 1; hosts: string[]; port: number; fp: string; secret: string; exp: string };

export type TransferEvent =
  | { type: 'paired'; deviceName: string }
  | { type: 'package-received'; pkg: ReceivedPackage }
  | { type: 'closed'; reason: CloseReason }
  | { type: 'error'; code: ErrorCode; message: string };

export interface TransferServiceOptions {
  dataDir: string;
  now?: () => number;
  hosts?: () => string[];
  /** Cada cuánto se comprueba la inactividad de la sesión (por defecto 60 s). */
  idleCheckMs?: number;
  log?: (message: string) => void;
}

type Active = { session: PairingSession; server: TransferServer; timer: NodeJS.Timeout };

export class TransferService {
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly hosts: () => string[];
  private readonly idleCheckMs: number;
  private readonly log: (message: string) => void;
  private readonly inbox: Inbox;
  private readonly listeners = new Set<(e: TransferEvent) => void>();
  private active: Active | undefined;
  /** Cierre en curso (detener o cierre de la sesión); start/stop lo esperan. */
  private ending: Promise<void> = Promise.resolve();
  /** Serializa start/stop. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: TransferServiceOptions) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? Date.now;
    this.hosts = opts.hosts ?? (() => privateIPv4Addresses());
    this.idleCheckMs = opts.idleCheckMs ?? IDLE_CHECK_MS;
    this.log = opts.log ?? (() => {});
    this.inbox = new Inbox(join(this.dataDir, 'inbox'), { now: this.now });
  }

  /** Abre una sesión nueva (si había una activa, la sustituye) y devuelve el QR. */
  start(): Promise<{ qr: QrPayload; qrText: string }> {
    return this.enqueue(async () => {
      this.end(undefined, false);
      await this.ending;

      const hosts = this.hosts();
      if (hosts.length === 0) throw new Error('No hay ninguna dirección IPv4 privada en la que escuchar');
      const cert = await loadOrCreateCertificate(join(this.dataDir, 'tls'));
      await this.inbox.cleanup();

      const session = new PairingSession({ now: this.now });
      const server = new TransferServer(cert, {
        session,
        inbox: this.inbox,
        onPaired: (deviceName) => this.emit({ type: 'paired', deviceName }),
        onPackageReceived: (pkg) => this.emit({ type: 'package-received', pkg }),
        onInternalError: (message) => this.emit({ type: 'error', code: 'internal', message }),
        log: this.log,
      });
      let port: number;
      try {
        port = await server.listen();
      } catch (err) {
        await server.close(false);
        throw err;
      }
      const timer = setInterval(() => session.checkIdle(), this.idleCheckMs);
      timer.unref();
      const active: Active = { session, server, timer };
      this.active = active;
      session.onClose((reason) => {
        if (this.active === active) this.end(reason, true);
      });

      const qr: QrPayload = { v: 1, hosts, port, fp: cert.fingerprint, secret: session.secret, exp: session.expiresAt.toISOString() };
      return { qr, qrText: JSON.stringify(qr) };
    });
  }

  /** Detiene la sesión y el servidor. Idempotente. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.end('stopped', false);
      await this.ending;
    });
  }

  listReceived(): Promise<ReceivedPackage[]> {
    return this.inbox.list();
  }

  packageDir(packageId: string): string {
    if (!UUID_RE.test(packageId)) throw new TransferError('not_found', 'Paquete no encontrado');
    return join(this.dataDir, 'inbox', packageId);
  }

  on(listener: (e: TransferEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Cierra la sesión activa. `reason` undefined: sustitución silenciosa (regenerar QR).
   * El evento `closed` se emite cuando el puerto ya no acepta conexiones.
   */
  private end(reason: CloseReason | undefined, graceful: boolean): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    clearInterval(active.timer);
    active.session.close(reason ?? 'stopped');
    const prev = this.ending;
    this.ending = Promise.all([prev, active.server.close(graceful)]).then(() => {
      if (reason) this.emit({ type: 'closed', reason });
    });
  }

  private emit(e: TransferEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.log(`listener de eventos falló: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
