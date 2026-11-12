import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers.js';

// Modo de la simulación de escrituras cortas en los temporales `.part`.
let mode: 'none' | 'partial' | 'lie' = 'none';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof real.open>) => {
    const fh = await real.open(...args);
    if (typeof args[0] === 'string' && args[0].endsWith('.part') && mode !== 'none') {
      const write = fh.write.bind(fh) as (b: Buffer, o: number, l: number, p: null) => Promise<{ bytesWritten: number; buffer: Buffer }>;
      Object.assign(fh, {
        write: async (b: Buffer, o = 0, l = b.length - o, p: null = null) => {
          // Escribe como mucho la mitad (al menos 1 byte) de lo pedido.
          const n = Math.max(1, Math.floor(l / 2));
          const r = await write(b, o, n, p);
          return mode === 'lie' ? { ...r, bytesWritten: l } : r;
        },
      });
    }
    return fh;
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

const { BlobStore } = await import('../blob-store.js');

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);

async function setup() {
  const root = tempDir();
  const store = new BlobStore(join(root, 'blobs'));
  const source = join(root, 'src.bin');
  await writeFile(source, PNG);
  return { root, store, source, hash: sha(PNG), size: PNG.length };
}

describe('BlobStore con escrituras cortas', () => {
  afterEach(() => {
    mode = 'none';
  });

  it('completa el trozo repitiendo write: el blob publicado es íntegro', async () => {
    const { store, source, hash, size } = await setup();
    mode = 'partial';
    await store.put(source, { sha256: hash, size, mime: 'image/png' });
    mode = 'none';
    expect((await readFile(store.pathOf(hash))).equals(PNG)).toBe(true);
  });

  it('si lo escrito no mide lo esperado: integrity_error, sin blob y tmp vacío', async () => {
    const { root, store, source, hash, size } = await setup();
    mode = 'lie';
    await expect(store.put(source, { sha256: hash, size, mime: 'image/png' })).rejects.toMatchObject({ code: 'integrity_error' });
    mode = 'none';
    expect(await store.has(hash)).toBe(false);
    expect(await readdir(join(root, 'blobs', 'tmp'))).toEqual([]);
  });
});
