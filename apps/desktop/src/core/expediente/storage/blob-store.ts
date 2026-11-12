import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, open as openFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
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

    // Se abre sin seguir enlaces y se valida sobre el descriptor abierto (sin ventana entre comprobar y leer).
    let src;
    try {
      src = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new ExpedienteError('integrity_error', 'El original de origen no es legible.');
    }
    const tmpDir = join(this.dir, TMP_DIR);
    const tmp = join(tmpDir, `${randomUUID()}.part`);
    let out;
    try {
      const st = await src.stat();
      if (!st.isFile() || st.size !== expected.size) {
        throw new ExpedienteError('integrity_error', 'El original de origen no es un archivo regular del tamaño esperado.');
      }
      await mkdir(tmpDir, { recursive: true });
      out = await openFile(tmp, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      const head: Buffer[] = [];
      let headLen = 0;
      const buf = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        if (size > expected.size) {
          throw new ExpedienteError('integrity_error', 'El original supera el tamaño esperado.');
        }
        const chunk = buf.subarray(0, bytesRead);
        hash.update(chunk);
        if (headLen < 12) {
          const part = Buffer.from(chunk.subarray(0, 12 - headLen));
          head.push(part);
          headLen += part.length;
        }
        await out.write(chunk);
      }

      if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
        throw new ExpedienteError('integrity_error', 'El original no coincide con el hash o tamaño esperados.');
      }
      if (!sniffOk(expected.mime, Buffer.concat(head))) {
        throw new ExpedienteError('integrity_error', 'El contenido del original no coincide con su tipo.');
      }
      await out.sync();
      await out.chmod(0o444);
      await out.close();
      out = undefined;

      const final = this.pathOf(expected.sha256);
      await mkdir(join(this.dir, expected.sha256.slice(0, 2)), { recursive: true });
      // link no reemplaza: si otro put ganó la carrera, el blob existente se conserva.
      try {
        await link(tmp, final);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      await rm(tmp, { force: true });
    } catch (e) {
      await out?.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      if (e instanceof ExpedienteError) throw e;
      throw new ExpedienteError('storage_error', 'No se pudo guardar el original.');
    } finally {
      await src.close().catch(() => {});
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

  /** Borra los temporales `.part` que haya dejado una interrupción y devuelve cuántos. */
  async cleanTmp(): Promise<number> {
    const tmpDir = join(this.dir, TMP_DIR);
    let names: string[];
    try {
      names = await readdir(tmpDir);
    } catch (e) {
      if (isEnoent(e)) return 0;
      throw new ExpedienteError('storage_error', 'No se pudo limpiar los temporales.');
    }
    const parts = names.filter((n) => n.endsWith('.part'));
    await Promise.all(parts.map((n) => rm(join(tmpDir, n), { force: true })));
    return parts.length;
  }
}
