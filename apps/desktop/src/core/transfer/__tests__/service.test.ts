import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { TLSSocket } from 'node:tls';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { errorSchema, qrSchema, receiptSchema } from '@fodibo/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TransferService, type QrPayload, type TransferEvent } from '../index.js';
import type { Manifest, ManifestFile } from '../types.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);
const validQr = ajv.compile(qrSchema);
const validError = ajv.compile(errorSchema);
const validReceipt = ajv.compile(receiptSchema);

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(20, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const JSONB = Buffer.from('{"a":1}');
const MIN = 60_000;

function entry(name: string, mime: ManifestFile['mime'], body: Buffer): ManifestFile {
  return { file_id: randomUUID(), name, mime, size: body.length, sha256: sha(body) };
}
function three(): { m: Manifest; bodies: Buffer[] } {
  const bodies = [JPEG, PDF, JSONB];
  const m: Manifest = {
    schema_version: 1,
    package_id: randomUUID(),
    created_at: '2026-11-10T21:26:10Z',
    device_name: 'Pixel 8',
    files: [entry('a.jpg', 'image/jpeg', JPEG), entry('b.pdf', 'application/pdf', PDF), entry('c.json', 'application/json', JSONB)],
  };
  return { m, bodies };
}

type Res = { status: number; headers: Record<string, unknown>; json: unknown; peerRaw: Buffer };

let dataDir: string;
let service: TransferService;
let events: TransferEvent[];
let qr: QrPayload;
let ca: string;

function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string | number>; maxVersion?: 'TLSv1.2' } = {},
): Promise<Res> {
  const raw =
    opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: qr.port,
        method,
        path,
        agent: false,
        ca,
        checkServerIdentity: () => undefined,
        maxVersion: opts.maxVersion,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(raw ? { 'content-length': raw.length } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const peerRaw = (res.socket as TLSSocket).getPeerCertificate().raw;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text ? JSON.parse(text) : undefined, peerRaw });
        });
      },
    );
    req.on('error', reject);
    req.end(raw);
  });
}

function expectError(r: Res, status: number, code: string) {
  expect(r.status).toBe(status);
  expect(validError(r.json)).toBe(true);
  expect((r.json as { error: { code: string; message: string } }).error.code).toBe(code);
  expect(JSON.stringify(r.json)).not.toMatch(/\bat .*\(|\.ts:\d+/);
}

function connectCode(port: number, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.on('connect', () => {
      s.destroy();
      resolve('CONNECTED');
    });
    s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERR'));
  });
}

function waitFor(type: TransferEvent['type']): Promise<TransferEvent> {
  return new Promise((resolve) => {
    const found = events.find((e) => e.type === type);
    if (found) return resolve(found);
    const off = service.on((e) => {
      if (e.type === type) {
        off();
        resolve(e);
      }
    });
  });
}

async function pair(): Promise<string> {
  const r = await call('POST', '/v1/pair', { body: { secret: qr.secret, device_name: 'Pixel 8' } });
  expect(r.status).toBe(200);
  return (r.json as { session_token: string }).session_token;
}

async function upload(token: string, m: Manifest, bodies: Buffer[]) {
  for (let i = 0; i < bodies.length; i++) {
    const r = await call('PUT', `/v1/packages/${m.package_id}/files/${m.files[i].sha256}`, { token, body: bodies[i] });
    expect(r.status).toBe(204);
  }
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

async function boot(opts: { now?: () => number; idleCheckMs?: number } = {}) {
  service = new TransferService({ dataDir, hosts: () => ['127.0.0.1'], ...opts });
  events = [];
  service.on((e) => events.push(e));
  ({ qr } = await service.start());
  ca = await readFile(join(dataDir, 'tls', 'cert.pem'), 'utf8');
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fodibo-svc-'));
});
afterEach(async () => {
  await service?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('TransferService', () => {
  it('qr válido y la huella coincide con el certificado presentado', async () => {
    await boot();
    const { qrText } = await service.start();
    qr = JSON.parse(qrText) as QrPayload;
    expect(validQr(qr)).toBe(true);
    expect(qr.hosts).toEqual(['127.0.0.1']);
    const r = await call('POST', '/v1/nada');
    expectError(r, 404, 'not_found');
    const fp = `sha256:${createHash('sha256').update(r.peerRaw).digest('hex')}`;
    expect(fp).toBe(qr.fp);
    expect(fp).toBe(`sha256:${createHash('sha256').update(new X509Certificate(ca).raw).digest('hex')}`);
  });

  it('escucha solo en IPv4 (0.0.0.0): por IPv6 (::1) no acepta conexiones', async () => {
    await boot();
    expect(await connectCode(qr.port)).toBe('CONNECTED');
    expect(await connectCode(qr.port, '::1')).not.toBe('CONNECTED');
  });

  it('TLS 1.2 forzado en el cliente: falla el handshake', async () => {
    await boot();
    await expect(call('POST', '/v1/pair', { maxVersion: 'TLSv1.2', body: {} })).rejects.toThrow();
  });

  it('flujo completo: pair → packages → PUT ×3 → commit; eventos paired y package-received', async () => {
    await boot();
    const token = await pair();
    const { m, bodies } = three();
    const ann = await call('POST', '/v1/packages', { token, body: m });
    expect(ann.status).toBe(200);
    expect(ann.json).toEqual({ package_id: m.package_id, missing: m.files.map((f) => f.sha256) });
    await upload(token, m, bodies);
    const c = await call('POST', `/v1/packages/${m.package_id}/commit`, { token });
    expect(c.status).toBe(200);
    expect(validReceipt(c.json)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['paired', 'package-received']);
    expect(events[0]).toEqual({ type: 'paired', deviceName: 'Pixel 8' });
    const got = events[1] as Extract<TransferEvent, { type: 'package-received' }>;
    expect(got.pkg.receipt).toEqual(c.json);
    expect(got.pkg.deviceName).toBe('Pixel 8');
    expect(await service.listReceived()).toEqual([got.pkg]);
    expect(service.packageDir(m.package_id)).toBe(join(dataDir, 'inbox', m.package_id));
  });

  it('PUT sin token: 401 unauthorized; con token: OK', async () => {
    await boot();
    const token = await pair();
    const { m } = three();
    await call('POST', '/v1/packages', { token, body: m });
    const path = `/v1/packages/${m.package_id}/files/${m.files[2].sha256}`;
    expectError(await call('PUT', path, { body: JSONB }), 401, 'unauthorized');
    expectError(await call('PUT', path, { body: JSONB, headers: { authorization: 'Basic abc' } }), 401, 'unauthorized');
    expectError(await call('PUT', path, { token: 'x'.repeat(43), body: JSONB }), 401, 'unauthorized');
    expect((await call('PUT', path, { token, body: JSONB })).status).toBe(204);
  });

  it('Content-Length mayor que el size declarado: 413 sin llamar al almacén (también si el archivo ya existe)', async () => {
    await boot();
    const token = await pair();
    const { m } = three();
    await call('POST', '/v1/packages', { token, body: m });
    const path = `/v1/packages/${m.package_id}/files/${m.files[2].sha256}`;
    const big = Buffer.concat([JSONB, Buffer.from('     ')]);
    expectError(await call('PUT', path, { token, body: big }), 413, 'too_large');
    expect((await call('PUT', path, { token, body: JSONB })).status).toBe(204);
    expectError(await call('PUT', path, { token, body: big }), 413, 'too_large');
  });

  it('cuerpo chunked mayor que el size: 413 y la conexión se cierra; el servidor sigue atendiendo', async () => {
    await boot();
    const token = await pair();
    const { m } = three();
    await call('POST', '/v1/packages', { token, body: m });
    const path = `/v1/packages/${m.package_id}/files/${m.files[2].sha256}`;
    const r = await new Promise<Res>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: qr.port, method: 'PUT', path, agent: false, ca, checkServerIdentity: () => undefined,
          headers: { authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString()), peerRaw: Buffer.alloc(0) }),
          );
        },
      );
      req.on('error', reject);
      req.write(JSONB);
      req.write(Buffer.alloc(64, 0x20));
    });
    expectError(r, 413, 'too_large');
    expect(r.headers.connection).toBe('close');
    expect((await call('PUT', path, { token, body: JSONB })).status).toBe(204);
  });

  it('validación de /v1/pair', async () => {
    await boot();
    expectError(await call('POST', '/v1/pair', { body: { device_name: 'x' } }), 401, 'invalid_secret');
    expectError(await call('POST', '/v1/pair', { body: { secret: 5, device_name: 'x' } }), 401, 'invalid_secret');
    expectError(await call('POST', '/v1/pair', { body: { secret: qr.secret, device_name: '' } }), 400, 'invalid_manifest');
    expectError(await call('POST', '/v1/pair', { body: { secret: qr.secret, device_name: 'x'.repeat(101) } }), 400, 'invalid_manifest');
    expectError(await call('POST', '/v1/pair', { body: Buffer.from('{no json') }), 400, 'invalid_manifest');
    expect(await pair()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('secreto incorrecto ×5: closed too-many-attempts y el puerto deja de aceptar conexiones', async () => {
    await boot();
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/v1/pair', { body: { secret: 'A'.repeat(22), device_name: 'x' } });
      expectError(r, 401, 'invalid_secret');
    }
    expect(await waitFor('closed')).toEqual({ type: 'closed', reason: 'too-many-attempts' });
    expect(await connectCode(qr.port)).toBe('ECONNREFUSED');
  });

  it('stop(): closed stopped, ECONNREFUSED en el mismo puerto; idempotente', async () => {
    await boot();
    const token = await pair();
    expect(token).toBeTruthy();
    await service.stop();
    await service.stop();
    expect(events.filter((e) => e.type === 'closed')).toEqual([{ type: 'closed', reason: 'stopped' }]);
    expect(await connectCode(qr.port)).toBe('ECONNREFUSED');
  });

  it('start() con sesión activa la sustituye: el puerto anterior se cierra', async () => {
    await boot();
    const old = qr;
    const next = await service.start();
    expect(next.qr.secret).not.toBe(old.secret);
    expect(await connectCode(old.port)).toBe('ECONNREFUSED');
    qr = next.qr;
    expect(await pair()).toBeTruthy();
  });

  it('(R6) inactividad: cierra el servidor sin esperar a una petición', async () => {
    const clock = { t: Date.now() };
    await boot({ now: () => clock.t, idleCheckMs: 10 });
    await pair();
    clock.t += 30 * MIN + 1;
    expect(await waitFor('closed')).toEqual({ type: 'closed', reason: 'inactive' });
    expect(await connectCode(qr.port)).toBe('ECONNREFUSED');
  });

  it('reenvío del mismo paquete tras commit: missing [], mismo recibo, un solo package-received', async () => {
    await boot();
    const token = await pair();
    const { m, bodies } = three();
    await call('POST', '/v1/packages', { token, body: m });
    await upload(token, m, bodies);
    const c1 = await call('POST', `/v1/packages/${m.package_id}/commit`, { token });
    const ann = await call('POST', '/v1/packages', { token, body: m });
    expect(ann.json).toEqual({ package_id: m.package_id, missing: [] });
    const c2 = await call('POST', `/v1/packages/${m.package_id}/commit`, { token });
    expect(c2.json).toEqual(c1.json);
    expect(events.filter((e) => e.type === 'package-received')).toHaveLength(1);
  });

  it('(Foco 4) nombre "../../etc/passwd": se acepta y nada sale de inbox/<package_id>/', async () => {
    await boot();
    const token = await pair();
    const m: Manifest = { ...three().m, files: [{ ...entry('../../etc/passwd', 'application/json', JSONB) }] };
    expect((await call('POST', '/v1/packages', { token, body: m })).status).toBe(200);
    await upload(token, m, [JSONB]);
    const c = await call('POST', `/v1/packages/${m.package_id}/commit`, { token });
    expect(c.status).toBe(200);
    expect((c.json as { files: ManifestFile[] }).files[0].name).toBe('../../etc/passwd');
    for (const f of await allFiles(dataDir)) {
      const rel = relative(dataDir, f).split(sep);
      const ok = rel[0] === 'tls' || (rel[0] === 'inbox' && rel[1] === m.package_id);
      expect(ok, f).toBe(true);
      expect(f).not.toMatch(/passwd/);
    }
  });

  it("packageDir('../x') lanza", async () => {
    service = new TransferService({ dataDir, hosts: () => ['127.0.0.1'] });
    expect(() => service.packageDir('../x')).toThrow();
  });

  it('cuerpo JSON de 2 MB en /v1/packages: 400 invalid_manifest', async () => {
    await boot();
    const token = await pair();
    const body = Buffer.from(JSON.stringify({ x: 'a'.repeat(2 * 1024 * 1024) }));
    expectError(await call('POST', '/v1/packages', { token, body }), 400, 'invalid_manifest');
  });

  it('rutas desconocidas o con ids malformados: 404 not_found', async () => {
    await boot();
    const token = await pair();
    expectError(await call('GET', '/v1/pair'), 404, 'not_found');
    expectError(await call('POST', '/v1/packages/../commit', { token }), 404, 'not_found');
    expectError(await call('POST', `/v1/packages/${randomUUID()}/commit`, { token }), 404, 'not_found');
  });
});
