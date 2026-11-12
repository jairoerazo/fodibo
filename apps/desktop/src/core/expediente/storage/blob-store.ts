import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open as openFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sniffOk } from '../../transfer/sniff.js';
import type { Mime } from '../../transfer/types.js';
import { ExpedienteError } from '../errors.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const TMP_DIR = 'tmp';

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Almacén de originales direccionado por SHA-256 (spec §4.2):
 * `<dir>/<aa>/<sha256>` y temporales en `<dir>/tmp/<uuid>.part`.
 * Las rutas solo se construyen a partir de un sha256 validado; nunca se siguen enlaces simbólicos.
 */
export class BlobStore {
  constructor(private readonly dir: string) {}

  private check(sha256: string): string {
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new ExpedienteError('invalid_input', 'Identificador de original no válido.');
    }
    return sha256;
  }

  /** Ruta del blob; solo para `showDocumentInFolder`. */
  pathOf(sha256: string): string {
    this.check(sha256);
    return join(this.dir, sha256.slice(0, 2), sha256);
  }

  async stat(sha256: string): Promise<{ size: number } | undefined> {
    const path = this.pathOf(sha256);
    try {
      const st = await lstat(path);
      return st.isFile() ? { size: st.size } : undefined;
    } catch (e) {
      if (isEnoent(e)) return undefined;
      throw new ExpedienteError('storage_error', 'No se pudo leer el almacén de originales.');
    }
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256)) !== undefined;
  }

  async put(source: string, expected: { sha256: string; size: number; mime: Mime }): Promise<void> {
    this.check(expected.sha256);
    if (await this.has(expected.sha256)) return;

    let st;
    try {
      st = await lstat(source);
    } catch {
      throw new ExpedienteError('integrity_error', 'El original de origen no es legible.');
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new ExpedienteError('integrity_error', 'El original de origen no es un archivo regular.');
    }

    const tmpDir = join(this.dir, TMP_DIR);
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const head: Buffer[] = [];
    let headLen = 0;
    try {
      const src = createReadStream(source, { flags: 'r' });
      src.on('data', (chunk) => {
        const buf = chunk as Buffer;
        hash.update(buf);
        size += buf.length;
        if (headLen < 12) {
          head.push(buf.subarray(0, 12 - headLen));
          headLen += head[head.length - 1]!.length;
        }
      });
      await pipeline(src, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));

      if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
        throw new ExpedienteError('integrity_error', 'El original no coincide con el hash o tamaño esperados.');
      }
      if (!sniffOk(expected.mime, Buffer.concat(head))) {
        throw new ExpedienteError('integrity_error', 'El contenido del original no coincide con su tipo.');
      }

      const fh = await openFile(tmp, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      const final = this.pathOf(expected.sha256);
      await mkdir(join(this.dir, expected.sha256.slice(0, 2)), { recursive: true });
      await rename(tmp, final);
      await chmod(final, 0o444);
    } catch (e) {
      await rm(tmp, { force: true });
      if (e instanceof ExpedienteError) throw e;
      throw new ExpedienteError('storage_error', 'No se pudo guardar el original.');
    }
  }

  /**
   * Abre el blob para lectura (`range` con extremos inclusivos). Es asíncrono: comprueba la
   * existencia antes de devolver el flujo y lanza `not_found` si falta.
   */
  async open(sha256: string, range?: { start: number; end: number }): Promise<Readable> {
    const st = await this.stat(sha256);
    if (!st) throw new ExpedienteError('not_found', 'Original no encontrado.');
    if (range && !(Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end >= range.start)) {
      throw new ExpedienteError('invalid_input', 'Rango no válido.');
    }
    return createReadStream(this.pathOf(sha256), range ? { start: range.start, end: range.end } : {});
  }

  async verify(sha256: string): Promise<{ ok: boolean; size?: number }> {
    const st = await this.stat(sha256);
    if (!st) return { ok: false };
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of createReadStream(this.pathOf(sha256))) {
        hash.update(chunk as Buffer);
        size += (chunk as Buffer).length;
      }
    } catch (e) {
      if (isEnoent(e)) return { ok: false };
      throw new ExpedienteError('storage_error', 'No se pudo leer el almacén de originales.');
    }
    return { ok: hash.digest('hex') === sha256, size };
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.pathOf(sha256), { force: true });
  }

  /** Todos los sha256 almacenados (excluye `tmp/`). */
  async list(): Promise<string[]> {
    let prefixes: string[];
    try {
      prefixes = await readdir(this.dir);
    } catch (e) {
      if (isEnoent(e)) return [];
      throw new ExpedienteError('storage_error', 'No se pudo leer el almacén de originales.');
    }
    const out: string[] = [];
    for (const p of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(p)) continue;
      for (const name of await readdir(join(this.dir, p))) {
        if (SHA256_RE.test(name) && name.startsWith(p)) out.push(name);
      }
    }
    return out.sort();
  }

  /** Borra los temporales `.part` que haya dejado una interrupción. */
  async cleanTmp(): Promise<void> {
    const tmpDir = join(this.dir, TMP_DIR);
    let names: string[];
    try {
      names = await readdir(tmpDir);
    } catch (e) {
      if (isEnoent(e)) return;
      throw new ExpedienteError('storage_error', 'No se pudo limpiar los temporales.');
    }
    await Promise.all(names.filter((n) => n.endsWith('.part')).map((n) => rm(join(tmpDir, n), { force: true })));
  }
}
