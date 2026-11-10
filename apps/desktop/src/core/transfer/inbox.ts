import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { TransferError } from './errors.js';
import { sniffOk } from './sniff.js';
import type { Manifest, ManifestFile, Receipt, ReceivedPackage } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;
const STALE_MS = 24 * 3_600_000;
const SNIFF_BYTES = 12;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const part = `${path}.${randomUUID()}.part`;
  await writeFile(part, data);
  await rename(part, path);
}

type Received = { sha256: string; bytes: number; head: Buffer };

/**
 * Escribe `body` en `partPath` calculando el hash en streaming. Si excede `maxBytes`
 * pausa el origen (sin destruirlo, para que la capa HTTP aún pueda responder) y falla con too_large.
 */
function receive(body: Readable, partPath: string, maxBytes: number): Promise<Received> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(partPath, { flags: 'wx' });
    const hash = createHash('sha256');
    const heads: Buffer[] = [];
    let headLen = 0;
    let bytes = 0;
    let settled = false;

    const detach = () => {
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onError);
      body.off('close', onClose);
      body.pause();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      detach();
      out.destroy();
      reject(err);
    };
    function onData(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      if (bytes > maxBytes) return fail(new TransferError('too_large', 'El cuerpo supera el tamaño declarado'));
      if (headLen < SNIFF_BYTES) {
        heads.push(buf.subarray(0, SNIFF_BYTES - headLen));
        headLen += heads[heads.length - 1].length;
      }
      hash.update(buf);
      if (!out.write(buf)) {
        body.pause();
        out.once('drain', () => body.resume());
      }
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      detach();
      out.end(() => resolve({ sha256: hash.digest('hex'), bytes, head: Buffer.concat(heads) }));
    }
    function onError(err: Error) {
      fail(err);
    }
    function onClose() {
      if (!body.readableEnded) fail(new TransferError('internal', 'Subida interrumpida'));
    }
    out.on('error', fail);
    body.on('data', onData);
    body.on('end', onEnd);
    body.on('error', onError);
    body.on('close', onClose);
  });
}

async function drain(body: Readable): Promise<void> {
  await new Promise<void>((resolve) => {
    body.on('end', resolve);
    body.on('close', resolve);
    body.on('error', () => resolve());
    body.resume();
  });
}

export class Inbox {
  private readonly now: () => number;

  constructor(
    private readonly root: string,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private dir(packageId: string): string {
    if (!UUID_RE.test(packageId)) throw new TransferError('not_found', 'Paquete no encontrado');
    return join(this.root, packageId);
  }

  private async readManifest(packageId: string): Promise<Manifest> {
    const dir = this.dir(packageId);
    try {
      return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      throw new TransferError('not_found', 'Paquete no encontrado');
    }
  }

  private async readReceipt(packageId: string): Promise<Receipt | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir(packageId), 'receipt.json'), 'utf8')) as Receipt;
    } catch {
      return undefined;
    }
  }

  private async missingOf(m: Manifest): Promise<string[]> {
    const filesDir = join(this.dir(m.package_id), 'files');
    const missing: string[] = [];
    for (const sha of new Set(m.files.map((f) => f.sha256))) {
      if (!(await exists(join(filesDir, sha)))) missing.push(sha);
    }
    return missing;
  }

  async announce(m: Manifest): Promise<{ package_id: string; missing: string[] }> {
    const dir = this.dir(m.package_id);
    const manifestPath = join(dir, 'manifest.json');
    if (await exists(manifestPath)) {
      const stored = await this.readManifest(m.package_id);
      if (canonical(stored) !== canonical(m)) {
        throw new TransferError('package_conflict', 'El paquete ya existe con otro manifiesto');
      }
    } else {
      await mkdir(join(dir, 'files'), { recursive: true });
      await writeAtomic(manifestPath, JSON.stringify(m));
    }
    if (await this.readReceipt(m.package_id)) return { package_id: m.package_id, missing: [] };
    return { package_id: m.package_id, missing: await this.missingOf(m) };
  }

  async storeFile(packageId: string, sha256: string, body: Readable): Promise<void> {
    const manifest = await this.readManifest(packageId);
    if (!SHA_RE.test(sha256)) throw new TransferError('not_found', 'Archivo no encontrado');
    const declared: ManifestFile | undefined = manifest.files.find((f) => f.sha256 === sha256);
    if (!declared) throw new TransferError('not_found', 'Archivo no encontrado');

    const filesDir = join(this.dir(packageId), 'files');
    const finalPath = join(filesDir, sha256);
    if (await exists(finalPath)) {
      await drain(body);
      return;
    }

    const partPath = join(filesDir, `${sha256}.${randomUUID()}.part`);
    try {
      const got = await receive(body, partPath, declared.size);
      if (got.bytes !== declared.size || got.sha256 !== sha256) {
        throw new TransferError('hash_mismatch', 'El contenido no coincide con el hash declarado');
      }
      if (!sniffOk(declared.mime, got.head)) {
        throw new TransferError('unsupported_type', 'El contenido no corresponde al tipo declarado');
      }
      if (declared.mime === 'application/json') {
        try {
          JSON.parse(await readFile(partPath, 'utf8'));
        } catch {
          throw new TransferError('unsupported_type', 'JSON ilegible');
        }
      }
      await rename(partPath, finalPath);
    } finally {
      await rm(partPath, { force: true });
    }
  }

  async commit(packageId: string): Promise<Receipt> {
    const manifest = await this.readManifest(packageId);
    const existing = await this.readReceipt(packageId);
    if (existing) return existing;
    if ((await this.missingOf(manifest)).length > 0) {
      throw new TransferError('incomplete_package', 'Faltan archivos por subir');
    }
    const receipt: Receipt = {
      schema_version: 1,
      package_id: manifest.package_id,
      received_at: new Date(this.now()).toISOString(),
      files: manifest.files.map((f) => ({ ...f, status: 'stored' as const })),
    };
    await writeAtomic(join(this.dir(packageId), 'receipt.json'), JSON.stringify(receipt));
    return receipt;
  }

  private async packageIds(): Promise<string[]> {
    try {
      return (await readdir(this.root)).filter((n) => UUID_RE.test(n));
    } catch {
      return [];
    }
  }

  async list(): Promise<ReceivedPackage[]> {
    const out: ReceivedPackage[] = [];
    for (const id of await this.packageIds()) {
      const receipt = await this.readReceipt(id);
      if (!receipt) continue;
      const manifest = await this.readManifest(id).catch(() => undefined);
      out.push({ receipt, deviceName: manifest?.device_name ?? '' });
    }
    return out.sort((a, b) => (a.receipt.received_at < b.receipt.received_at ? 1 : -1));
  }

  async cleanup(): Promise<void> {
    for (const id of await this.packageIds()) {
      const dir = join(this.root, id);
      const parts = async (d: string) => {
        for (const n of await readdir(d).catch(() => [] as string[])) {
          if (n.endsWith('.part')) await rm(join(d, n), { force: true });
        }
      };
      await parts(dir);
      await parts(join(dir, 'files'));
      if (await exists(join(dir, 'receipt.json'))) continue;
      const st = await stat(join(dir, 'manifest.json')).catch(() => undefined);
      if (st && this.now() - st.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true });
    }
  }
}
