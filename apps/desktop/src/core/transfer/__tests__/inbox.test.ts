import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TransferError } from '../errors.js';
import { Inbox } from '../inbox.js';
import type { Manifest, ManifestFile } from '../types.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF'), Buffer.alloc(20, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const JSONB = Buffer.from('{"a":1}');

function entry(name: string, mime: ManifestFile['mime'], body: Buffer, hash = sha(body)): ManifestFile {
  return { file_id: randomUUID(), name, mime, size: body.length, sha256: hash };
}
function manifestOf(files: ManifestFile[], over: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: 1,
    package_id: randomUUID(),
    created_at: '2026-11-10T21:26:10Z',
    device_name: 'Pixel 8',
    files,
    ...over,
  };
}
function three() {
  return manifestOf([
    entry('a.jpg', 'image/jpeg', JPEG),
    entry('b.pdf', 'application/pdf', PDF),
    entry('c.json', 'application/json', JSONB),
  ]);
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransferError);
    return (e as TransferError).code;
  }
  return undefined;
}

let root: string;
let inbox: Inbox;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fodibo-inbox-'));
  inbox = new Inbox(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe('Inbox', () => {
  it('flujo completo', async () => {
    const m = three();
    const { package_id, missing } = await inbox.announce(m);
    expect(package_id).toBe(m.package_id);
    expect(missing).toHaveLength(3);
    await inbox.storeFile(package_id, sha(JPEG), Readable.from([JPEG]));
    await inbox.storeFile(package_id, sha(PDF), Readable.from([PDF]));
    await inbox.storeFile(package_id, sha(JSONB), Readable.from([JSONB]));
    const receipt = await inbox.commit(package_id);
    expect(receipt.files).toHaveLength(3);
    expect(receipt.files.every((f) => f.status === 'stored')).toBe(true);
    for (const f of receipt.files) {
      const data = await readFile(join(root, package_id, 'files', f.sha256));
      expect(sha(data)).toBe(f.sha256);
    }
  });

  it('reanudación: solo faltan los no guardados', async () => {
    const m = three();
    await inbox.announce(m);
    await inbox.storeFile(m.package_id, sha(PDF), Readable.from([PDF]));
    const { missing } = await inbox.announce(m);
    expect(missing.sort()).toEqual([sha(JPEG), sha(JSONB)].sort());
  });

  it('idempotencia tras commit', async () => {
    const m = three();
    await inbox.announce(m);
    await inbox.storeFile(m.package_id, sha(JPEG), Readable.from([JPEG]));
    await inbox.storeFile(m.package_id, sha(PDF), Readable.from([PDF]));
    await inbox.storeFile(m.package_id, sha(JSONB), Readable.from([JSONB]));
    const r1 = await inbox.commit(m.package_id);
    expect((await inbox.announce(m)).missing).toEqual([]);
    expect(await inbox.commit(m.package_id)).toEqual(r1);
  });

  it('conflicto: mismo package_id con otro manifiesto', async () => {
    const m = three();
    await inbox.announce(m);
    const other = { ...m, device_name: 'Otro' };
    expect(await codeOf(inbox.announce(other))).toBe('package_conflict');
  });

  it('el mismo manifiesto con claves en otro orden no es conflicto', async () => {
    const m = three();
    await inbox.announce(m);
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(m).reverse())));
    await expect(inbox.announce(reordered)).resolves.toBeDefined();
  });

  it('commit incompleto', async () => {
    const m = three();
    await inbox.announce(m);
    await inbox.storeFile(m.package_id, sha(JPEG), Readable.from([JPEG]));
    expect(await codeOf(inbox.commit(m.package_id))).toBe('incomplete_package');
    expect(existsSync(join(root, m.package_id, 'receipt.json'))).toBe(false);
  });

  it('commit de paquete desconocido: not_found', async () => {
    expect(await codeOf(inbox.commit(randomUUID()))).toBe('not_found');
  });

  it('hash incorrecto: hash_mismatch sin restos', async () => {
    const m = manifestOf([entry('a.jpg', 'image/jpeg', JPEG, 'b'.repeat(64))]);
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, 'b'.repeat(64), Readable.from([JPEG])))).toBe('hash_mismatch');
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
  });

  it('longitud distinta a la declarada: hash_mismatch', async () => {
    const m = manifestOf([entry('a.jpg', 'image/jpeg', JPEG)]);
    await inbox.announce(m);
    const short = JPEG.subarray(0, JPEG.length - 1);
    expect(await codeOf(inbox.storeFile(m.package_id, sha(JPEG), Readable.from([short])))).toBe('hash_mismatch');
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
  });

  it('(Foco 2) cuerpo con size + 1 bytes: too_large sin restos', async () => {
    const m = manifestOf([entry('a.jpg', 'image/jpeg', JPEG)]);
    await inbox.announce(m);
    const longer = Buffer.concat([JPEG, Buffer.from([1])]);
    expect(await codeOf(inbox.storeFile(m.package_id, sha(JPEG), Readable.from([longer])))).toBe('too_large');
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
  });

  it('(Foco 2) corta sin leer el cuerpo entero (10 MB con size de 10 bytes)', async () => {
    const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(7)]);
    const m = manifestOf([entry('a.jpg', 'image/jpeg', small)]);
    await inbox.announce(m);
    let pulled = 0;
    const chunk = Buffer.alloc(64 * 1024, 0xff);
    async function* gen() {
      for (let i = 0; i < 160; i++) {
        pulled += chunk.length;
        yield chunk;
      }
    }
    const body = Readable.from(gen(), { objectMode: false, highWaterMark: 64 * 1024 });
    expect(await codeOf(inbox.storeFile(m.package_id, sha(small), body))).toBe('too_large');
    expect(pulled).toBeLessThan(1024 * 1024);
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
    body.destroy();
  });

  it('(Foco 5) archivo vacío declarado como image/jpeg: unsupported_type', async () => {
    const empty = Buffer.alloc(0);
    const m = manifestOf([entry('a.jpg', 'image/jpeg', empty)]);
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, sha(empty), Readable.from([])))).toBe('unsupported_type');
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
  });

  it('(Foco 5) JSON ilegible: unsupported_type', async () => {
    const bad = Buffer.from('{oops');
    const m = manifestOf([entry('a.json', 'application/json', bad)]);
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, sha(bad), Readable.from([bad])))).toBe('unsupported_type');
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([]);
  });

  it('contenido que no coincide con el mime: unsupported_type', async () => {
    const m = manifestOf([entry('a.png', 'image/png', JPEG)]);
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, sha(JPEG), Readable.from([JPEG])))).toBe('unsupported_type');
  });

  it('(Foco 1) mismo sha dos veces: una sola subida, recibo con 2 entradas', async () => {
    const m = manifestOf([entry('a.jpg', 'image/jpeg', JPEG), entry('a copia.jpg', 'image/jpeg', JPEG)]);
    const { missing } = await inbox.announce(m);
    expect(missing).toEqual([sha(JPEG)]);
    await inbox.storeFile(m.package_id, sha(JPEG), Readable.from([JPEG]));
    const r = await inbox.commit(m.package_id);
    expect(r.files).toHaveLength(2);
    expect(r.files.map((f) => f.name)).toEqual(['a.jpg', 'a copia.jpg']);
    expect(await readdir(join(root, m.package_id, 'files'))).toEqual([sha(JPEG)]);
  });

  it('(Foco 3) dos storeFile simultáneos del mismo hash', async () => {
    const m = manifestOf([entry('a.pdf', 'application/pdf', PDF)]);
    await inbox.announce(m);
    const slow = () =>
      Readable.from(
        (async function* () {
          yield PDF.subarray(0, 5);
          await new Promise((r) => setTimeout(r, 20));
          yield PDF.subarray(5);
        })(),
      );
    await Promise.all([
      inbox.storeFile(m.package_id, sha(PDF), slow()),
      inbox.storeFile(m.package_id, sha(PDF), slow()),
    ]);
    const files = await readdir(join(root, m.package_id, 'files'));
    expect(files).toEqual([sha(PDF)]);
    expect(sha(await readFile(join(root, m.package_id, 'files', sha(PDF))))).toBe(sha(PDF));
  });

  it('archivo ya presente: consume el cuerpo y retorna', async () => {
    const m = manifestOf([entry('a.pdf', 'application/pdf', PDF)]);
    await inbox.announce(m);
    await inbox.storeFile(m.package_id, sha(PDF), Readable.from([PDF]));
    await expect(inbox.storeFile(m.package_id, sha(PDF), Readable.from([PDF]))).resolves.toBeUndefined();
  });

  it('hash fuera del manifiesto: not_found', async () => {
    const m = three();
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, 'c'.repeat(64), Readable.from([JPEG])))).toBe('not_found');
  });

  it('paquete desconocido: not_found', async () => {
    expect(await codeOf(inbox.storeFile(randomUUID(), sha(JPEG), Readable.from([JPEG])))).toBe('not_found');
  });

  it('ids malformados (rutas) se rechazan con not_found sin tocar el disco', async () => {
    expect(await codeOf(inbox.storeFile('../../etc', sha(JPEG), Readable.from([JPEG])))).toBe('not_found');
    const m = three();
    await inbox.announce(m);
    expect(await codeOf(inbox.storeFile(m.package_id, '../manifest.json', Readable.from([JPEG])))).toBe('not_found');
    expect(await codeOf(inbox.commit('../x'))).toBe('not_found');
  });

  it('cleanup: borra .part y paquetes sin recibo de 25 h; conserva el resto', async () => {
    const old = three();
    const recent = three();
    const done = three();
    for (const m of [old, recent, done]) await inbox.announce(m);
    for (const b of [JPEG, PDF, JSONB]) await inbox.storeFile(done.package_id, sha(b), Readable.from([b]));
    await inbox.commit(done.package_id);
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await utimes(join(root, old.package_id, 'manifest.json'), ago(25), ago(25));
    await utimes(join(root, recent.package_id, 'manifest.json'), ago(1), ago(1));
    await utimes(join(root, done.package_id, 'manifest.json'), ago(48), ago(48));
    await writeFile(join(root, recent.package_id, 'files', 'x.uuid.part'), 'z');
    await inbox.cleanup();
    expect(existsSync(join(root, old.package_id))).toBe(false);
    expect(existsSync(join(root, recent.package_id))).toBe(true);
    expect(existsSync(join(root, done.package_id, 'receipt.json'))).toBe(true);
    expect((await allFiles(root)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('list: más recientes primero, con deviceName', async () => {
    const clock = { t: Date.parse('2026-11-10T10:00:00Z') };
    const ib = new Inbox(root, { now: () => clock.t });
    const a = manifestOf([entry('a.json', 'application/json', JSONB)], { device_name: 'Uno' });
    const b = manifestOf([entry('a.json', 'application/json', JSONB)], { device_name: 'Dos' });
    for (const m of [a, b]) {
      await ib.announce(m);
      await ib.storeFile(m.package_id, sha(JSONB), Readable.from([JSONB]));
      await ib.commit(m.package_id);
      clock.t += 60_000;
    }
    const list = await ib.list();
    expect(list.map((p) => p.deviceName)).toEqual(['Dos', 'Uno']);
    expect(list[0].receipt.package_id).toBe(b.package_id);
    expect(list[0].receipt.received_at).toBe('2026-11-10T10:01:00.000Z');
  });

  it('list sin carpeta raíz ni paquetes', async () => {
    expect(await new Inbox(join(root, 'nada')).list()).toEqual([]);
  });
});
