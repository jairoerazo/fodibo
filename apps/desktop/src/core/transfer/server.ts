import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TransferError } from './errors.js';
import type { Inbox } from './inbox.js';
import type { PairingSession } from './session.js';
import { MAX_FILE_BYTES, type ReceivedPackage } from './types.js';
import { parseManifest } from './validate.js';

const JSON_LIMIT = 1024 * 1024;
/** Cuerpo JSON excesivo: se descarta hasta este total para poder responder; más allá se corta la conexión. */
const JSON_DISCARD_LIMIT = 16 * 1024 * 1024;
const GRACEFUL_CLOSE_MS = 5_000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const FILE_RE = new RegExp(`^/v1/packages/(${UUID})/files/([0-9a-f]{64})$`);
const COMMIT_RE = new RegExp(`^/v1/packages/(${UUID})/commit$`);
const BEARER_RE = /^Bearer (\S+)$/;

export interface ServerHooks {
  session: PairingSession;
  inbox: Inbox;
  onPaired(deviceName: string): void;
  onPackageReceived(pkg: ReceivedPackage): void;
  /** Error interno no provocado por el cliente (500). */
  onInternalError(message: string): void;
  log(message: string): void;
}

/** El cliente cortó la conexión: no hay a quién responder y no es un fallo del PC. */
class ClientAborted extends Error {}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total <= JSON_LIMIT) chunks.push(c);
      else if (total > JSON_DISCARD_LIMIT) {
        req.pause();
        done(() => reject(new TransferError('invalid_manifest', 'Cuerpo demasiado grande')));
      }
    });
    req.on('end', () =>
      done(() => {
        if (total > JSON_LIMIT) return reject(new TransferError('invalid_manifest', 'Cuerpo demasiado grande'));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new TransferError('invalid_manifest', 'JSON inválido'));
        }
      }),
    );
    req.on('close', () => done(() => reject(new ClientAborted('Petición interrumpida'))));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

export class TransferServer {
  private readonly server: https.Server;
  private inFlight = 0;
  private closing: Promise<void> | undefined;
  private readonly commits = new Map<string, Promise<unknown>>();

  constructor(
    tls: { certPem: string; keyPem: string },
    private readonly hooks: ServerHooks,
  ) {
    this.server = https.createServer({ cert: tls.certPem, key: tls.keyPem, minVersion: 'TLSv1.3' }, (req, res) => {
      void this.handle(req, res);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(0, () => {
        this.server.off('error', onError);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  /**
   * Deja de aceptar conexiones. `graceful`: las peticiones en curso terminan (con `Connection: close`)
   * antes de cortar el resto; si no, se cortan todas de inmediato.
   */
  close(graceful: boolean): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
      if (!graceful || this.inFlight === 0) return this.server.closeAllConnections();
      this.server.closeIdleConnections();
      const timer = setTimeout(() => this.server.closeAllConnections(), GRACEFUL_CLOSE_MS);
      timer.unref();
      this.server.once('close', () => clearTimeout(timer));
    });
    return this.closing;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inFlight++;
    res.once('close', () => {
      if (--this.inFlight === 0 && this.closing) this.server.closeAllConnections();
    });
    req.on('error', () => {});
    try {
      await this.route(req, res);
    } catch (err) {
      this.fail(req, res, err);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    const { session, inbox } = this.hooks;

    if (req.method === 'POST' && path === '/v1/pair') {
      const body = (await readJson(req)) as { secret?: unknown; device_name?: unknown } | null;
      const secret = body?.secret;
      const deviceName = body?.device_name;
      if (typeof secret !== 'string') throw new TransferError('invalid_secret', 'Secreto ausente');
      if (typeof deviceName !== 'string' || deviceName.length < 1 || deviceName.length > 100) {
        throw new TransferError('invalid_manifest', 'device_name inválido');
      }
      const { sessionToken } = session.pair(secret, deviceName);
      this.reply(res, 200, { session_token: sessionToken });
      this.hooks.onPaired(deviceName);
      return;
    }

    const fileMatch = req.method === 'PUT' ? FILE_RE.exec(path) : null;
    const commitMatch = req.method === 'POST' ? COMMIT_RE.exec(path) : null;
    const isAnnounce = req.method === 'POST' && path === '/v1/packages';
    if (!fileMatch && !commitMatch && !isAnnounce) throw new TransferError('not_found', 'Ruta desconocida');

    const auth = BEARER_RE.exec(req.headers.authorization ?? '');
    if (!auth) throw new TransferError('unauthorized', 'Falta el token de sesión');
    session.authenticate(auth[1]);

    if (isAnnounce) {
      const manifest = parseManifest(await readJson(req));
      this.reply(res, 200, await inbox.announce(manifest));
    } else if (fileMatch) {
      const [, packageId, sha256] = fileMatch;
      const declared = await inbox.fileEntry(packageId, sha256);
      const length = req.headers['content-length'];
      if (length !== undefined && (Number(length) > declared.size || Number(length) > MAX_FILE_BYTES)) {
        throw new TransferError('too_large', 'El cuerpo supera el tamaño declarado');
      }
      await inbox.storeFile(packageId, sha256, req);
      this.reply(res, 204);
    } else if (commitMatch) {
      const packageId = commitMatch[1];
      const { pkg, created } = await this.serialCommit(packageId);
      this.reply(res, 200, pkg.receipt);
      if (created) this.hooks.onPackageReceived(pkg);
    }
  }

  /** Dos commits simultáneos del mismo paquete no deben crear (ni anunciar) dos recibos. */
  private serialCommit(packageId: string) {
    const prev = this.commits.get(packageId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.hooks.inbox.commitPackage(packageId));
    this.commits.set(packageId, next);
    void next.catch(() => {}).finally(() => {
      if (this.commits.get(packageId) === next) this.commits.delete(packageId);
    });
    return next;
  }

  private reply(res: ServerResponse, status: number, body?: unknown): void {
    // Si la sesión se cerró durante esta petición, que el cliente no reutilice la conexión.
    if (this.hooks.session.closed) res.setHeader('connection', 'close');
    if (body === undefined) {
      res.writeHead(status);
      res.end();
    } else {
      sendJson(res, status, body);
    }
  }

  private fail(req: IncomingMessage, res: ServerResponse, err: unknown): void {
    const aborted = err instanceof ClientAborted || (!req.complete && req.socket.destroyed);
    if (aborted || res.headersSent || res.destroyed) {
      this.hooks.log(`petición ${req.method} ${req.url} interrumpida por el cliente`);
      return;
    }
    let te: TransferError;
    if (err instanceof TransferError && err.code !== 'internal') {
      te = err;
    } else {
      te = new TransferError('internal', 'Error interno');
      const detail = err instanceof Error ? err.message : String(err);
      this.hooks.log(`error interno en ${req.method} ${req.url}: ${detail}`);
      this.hooks.onInternalError(detail);
    }
    if (!req.complete) {
      // Cuerpo sin consumir: responder y cortar la conexión en lugar de leer el resto.
      res.setHeader('connection', 'close');
      res.once('finish', () => req.socket.destroy());
    }
    this.reply(res, te.status, { error: { code: te.code, message: te.message } });
  }
}
