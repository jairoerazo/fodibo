import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store.js';
import { tempDir } from './helpers.js';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0123456789abcdef')]);
const PDF = Buffer.from('%PDF-1.4 contenido de prueba');

async function setup(bytes: Buffer = PNG) {
  const root = tempDir();
  const store = new BlobStore(join(root, 'blobs'));
  const source = join(root, 'src.bin');
  await writeFile(source, bytes);
  return { root, store, source, hash: sha(bytes), size: bytes.length };
}
async function read(s: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

describe('BlobStore', () => {
  it('put + has + open devuelve los mismos bytes y modo 0o444', async () => {
    const { store, source, hash, size } = await setup();
    expect(await store.has(hash)).toBe(false);
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    expect(await store.has(hash)).toBe(true);
    expect((await read(await store.open(hash))).equals(PNG)).toBe(true);
    expect((await lstat(store.pathOf(hash))).mode & 0o777).toBe(0o444);
    expect(await store.stat(hash)).toEqual({ size });
  });

  it('un put repetido no reescribe', async () => {
    const { store, source, hash, size } = await setup();
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    const m1 = (await lstat(store.pathOf(hash))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    expect((await lstat(store.pathOf(hash))).mtimeMs).toBe(m1);
  });

  it('hash distinto: integrity_error, sin blob y tmp vacío', async () => {
    const { store, source, size } = await setup();
    const bad = 'a'.repeat(64);
    await expect(store.put(source, { sha256: bad, size, mime: 'image/png' })).rejects.toMatchObject({ code: 'integrity_error' });
    expect(await store.has(bad)).toBe(false);
    expect(await readdir(join(store.pathOf(bad), '..', '..', 'tmp'))).toEqual([]);
  });

  it('tamaño distinto: integrity_error', async () => {
    const { store, source, hash, size } = await setup();
    await expect(store.put(source, { sha256: hash, size: size + 1, mime: 'image/png' })).rejects.toMatchObject({ code: 'integrity_error' });
  });

  it('origen que es enlace simbólico: integrity_error', async () => {
    const { root, store, source, hash, size } = await setup();
    const link = join(root, 'link.bin');
    await symlink(source, link);
    await expect(store.put(link, { sha256: hash, size, mime: 'image/png' })).rejects.toMatchObject({ code: 'integrity_error' });
    expect(await store.has(hash)).toBe(false);
  });

  it('PDF declarado como image/png: integrity_error y tmp vacío', async () => {
    const { store, source, hash, size } = await setup(PDF);
    await expect(store.put(source, { sha256: hash, size, mime: 'image/png' })).rejects.toMatchObject({ code: 'integrity_error' });
    expect(await store.has(hash)).toBe(false);
    expect(await readdir(join(store.pathOf(hash), '..', '..', 'tmp'))).toEqual([]);
  });

  it('open con rango devuelve start..end inclusivos', async () => {
    const { store, source, hash, size } = await setup();
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    expect((await read(await store.open(hash, { start: 8, end: 12 }))).equals(PNG.subarray(8, 13))).toBe(true);
  });

  it('open de un blob ausente: not_found', async () => {
    const { store } = await setup();
    await expect(store.open('b'.repeat(64))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('verify detecta un blob alterado', async () => {
    const { store, source, hash, size } = await setup();
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    expect(await store.verify(hash)).toEqual({ ok: true, size });
    await chmod(store.pathOf(hash), 0o644);
    await writeFile(store.pathOf(hash), Buffer.concat([PNG.subarray(0, 20), Buffer.from('X')]));
    expect((await store.verify(hash)).ok).toBe(false);
    expect((await store.verify('c'.repeat(64))).ok).toBe(false);
  });

  it('list no incluye tmp/ y remove borra', async () => {
    const { store, source, hash, size } = await setup();
    expect(await store.list()).toEqual([]);
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    await mkdir(join(store.pathOf(hash), '..', '..', 'tmp'), { recursive: true });
    await writeFile(join(store.pathOf(hash), '..', '..', 'tmp', 'x.part'), 'x');
    expect(await store.list()).toEqual([hash]);
    await store.remove(hash);
    expect(await store.list()).toEqual([]);
  });

  it('cleanTmp borra los .part', async () => {
    const { root, store } = await setup();
    const tmp = join(root, 'blobs', 'tmp');
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, 'a.part'), 'x');
    await store.cleanTmp();
    expect(await readdir(tmp)).toEqual([]);
  });

  it('rechaza sha256 no válido con invalid_input', async () => {
    const { store } = await setup();
    await expect(store.has('../x')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(() => store.pathOf('../x')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    await expect(store.remove('../x')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
