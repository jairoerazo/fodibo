import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && p !== fileURLToPath(import.meta.url) ? [p] : [];
  });
}

const files = sources(ROOT);
const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');

// Se construyen con concatenación para que esta prueba no se detecte a sí misma (además se excluye).
const FORBIDDEN = ['electron', 'react', 'node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'undici'];

describe('aislamiento del núcleo del expediente', () => {
  it('hay archivos que comprobar', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('ningún .ts importa electron, react ni módulos de red', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const mod of FORBIDDEN) {
        const re = new RegExp(`(from\\s+|import\\s*\\(\\s*|require\\(\\s*|import\\s+)['"]${mod}(/[^'"]*)?['"]`);
        expect(re.test(text), `${rel(f)} importa ${mod}`).toBe(false);
      }
      expect(/\bfetch\(/.test(text), `${rel(f)} usa fetch(`).toBe(false);
    }
  });

  it('solo los archivos bajo storage/ contienen node:sqlite', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('node:sqlite')).map(rel);
    expect(offenders.filter((f) => !f.startsWith('storage/'))).toEqual([]);
    expect(offenders.length).toBeGreaterThan(0);
  });
});
