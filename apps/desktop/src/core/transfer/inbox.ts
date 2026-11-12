import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream as fsCreateWriteStream, type WriteStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
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

/** Extensiones aceptadas por tipo; la primera es la que se añade si falta. */
const EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/heic': ['heic', 'heif'],
  'application/pdf': ['pdf'],
  'application/json': ['json'],
};
const MAX_NAME_BYTES = 200;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Nombre seguro para mostrar un archivo con su nombre original: sin rutas, sin caracteres de control ni
 * separadores, sin puntos o espacios en los extremos, con la extensión del tipo ya verificado (un
 * «x.command» declarado como PNG queda «x.command.png») y como mucho 200 bytes.
 */
export function originalName(name: string, mime: string): string {
  const exts = EXTENSIONS[mime] ?? ['bin'];
  let n = (name.normalize('NFC').split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f:<>"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (n === '') n = 'archivo';
  const ext = /\.([^.]+)$/.exec(n)?.[1];
  if (ext === undefined || !exts.includes(ext.toLowerCase())) n = `${n}.${exts[0]}`;
  if (WINDOWS_RESERVED.test(n.split('.')[0]!)) n = `_${n}`;
  return fitName(n);
}

function splitExt(n: string): [string, string] {
  const i = n.lastIndexOf('.');
  return i > 0 ? [n.slice(0, i), n.slice(i)] : [n, ''];
}

function fitName(n: string): string {
  if (Buffer.byteLength(n) <= MAX_NAME_BYTES) return n;
  const [stem, ext] = splitExt(n);
  const chars = [...stem];
  while (chars.length > 1 && Buffer.byteLength(chars.join('') + ext) > MAX_NAME_BYTES) chars.pop();
  return chars.join('') + ext;
}

/** Nombres originales sin colisiones (sin distinguir mayúsculas): «foto (2).jpg», «foto (3).jpg»… */
function uniqueNames(files: ManifestFile[]): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const base = originalName(f.name, f.mime);
    let n = base;
    for (let k = 2; used.has(n.toLowerCase()); k++) {
      const [stem, ext] = splitExt(base);
      n = fitName(`${stem} (${k})${ext}`);
    }
    used.add(n.toLowerCase());
    return n;
  });
}

type Received = { sha256: string; bytes: number; head: Buffer };

/**
 * Escribe `body` en `partPath` calculando el hash en streaming. Si excede `maxBytes`
 * pausa el origen (sin destruirlo, para que la capa HTTP aún pueda responder) y falla con too_large.
 */
type OpenWrite = (path: string, opts: { flags: string }) => WriteStream;

/** Espera a que el WriteStream esté cerrado del todo (fd liberado) antes de seguir. */
async function closed(out: WriteStream): Promise<void> {
  if (out.closed) return;
  await new Promise<void>((r) => out.once('close', () => r()));
}

function receive(body: Readable, partPath: string, maxBytes: number, open: OpenWrite): Promise<Received> {
  return new Promise((resolve, reject) => {
    const out = open(partPath, { flags: 'wx' });
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
      void closed(out).then(() => reject(err));
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
      const result = { sha256: hash.digest('hex'), bytes, head: Buffer.concat(heads) };
      out.end();
      finished(out).then(
        () => resolve(result),
        (err: Error) => {
          out.destroy();
          void closed(out).then(() => reject(err));
        },
      );
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

  private readonly openWrite: OpenWrite;

  constructor(
    private readonly root: string,
    opts: { now?: () => number; createWriteStream?: OpenWrite } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.openWrite = opts.createWriteStream ?? fsCreateWriteStream;
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

  /** Entrada del manifiesto para `sha256`; `not_found` si el paquete o el hash no existen. */
  async fileEntry(packageId: string, sha256: string): Promise<ManifestFile> {
    const manifest = await this.readManifest(packageId);
    const declared = SHA_RE.test(sha256) ? manifest.files.find((f) => f.sha256 === sha256) : undefined;
    if (!declared) throw new TransferError('not_found', 'Archivo no encontrado');
    return declared;
  }

  async storeFile(packageId: string, sha256: string, body: Readable): Promise<void> {
    const declared = await this.fileEntry(packageId, sha256);

    const filesDir = join(this.dir(packageId), 'files');
    const finalPath = join(filesDir, sha256);
    if (await exists(finalPath)) {
      await drain(body);
      return;
    }

    const partPath = join(filesDir, `${sha256}.${randomUUID()}.part`);
    try {
      const got = await receive(body, partPath, declared.size, this.openWrite);
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
    return (await this.commitPackage(packageId)).pkg.receipt;
  }

  /** Como `commit`, indicando además si el recibo se acaba de crear (`created`) o ya existía. */
  async commitPackage(packageId: string): Promise<{ pkg: ReceivedPackage; created: boolean }> {
    const manifest = await this.readManifest(packageId);
    const deviceName = manifest.device_name;
    const existing = await this.readReceipt(packageId);
    if (existing) return { pkg: { receipt: existing, deviceName }, created: false };
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
    await this.writeOriginals(manifest);
    return { pkg: { receipt, deviceName }, created: true };
  }

  /**
   * Crea `originales/` con cada archivo del paquete con su nombre original (enlace duro al archivo por
   * hash; copia si el sistema de archivos no admite enlaces). Es una comodidad para abrirlos desde el
   * Finder: si falla, el paquete sigue completo y `cleanup` lo reintenta en el siguiente arranque.
   */
  private async writeOriginals(manifest: Manifest): Promise<void> {
    const dir = this.dir(manifest.package_id);
    const final = join(dir, 'originales');
    if (await exists(final)) return;
    const tmp = join(dir, `originales.${randomUUID()}.part`);
    try {
      await mkdir(tmp);
      const names = uniqueNames(manifest.files);
      for (const [i, f] of manifest.files.entries()) {
        const src = join(dir, 'files', f.sha256);
        const dst = join(tmp, names[i]!);
        await link(src, dst).catch(() => copyFile(src, dst));
      }
      await rename(tmp, final);
    } catch {
      // comodidad, no parte del recibo: se reintenta en `cleanup`
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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
          if (n.endsWith('.part')) await rm(join(d, n), { recursive: true, force: true });
        }
      };
      await parts(dir);
      await parts(join(dir, 'files'));
      if (await exists(join(dir, 'receipt.json'))) {
        const manifest = await this.readManifest(id).catch(() => undefined);
        if (manifest) await this.writeOriginals(manifest);
        continue;
      }
      const st = await stat(join(dir, 'manifest.json')).catch(() => undefined);
      if (st && this.now() - st.mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true });
    }
  }
}
