import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransferError } from '../errors.js';
import { parseManifest } from '../validate.js';

const vectors = fileURLToPath(new URL('../../../../../../packages/contracts/vectors/manifest/', import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(join(vectors, p), 'utf8'));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TransferError);
    return (e as TransferError).code;
  }
  return undefined;
}

function manifestOf(sizes: number[]) {
  const base = load('valid/three-types.json');
  return {
    ...base,
    files: sizes.map((size, i) => ({
      file_id: `0c9d8e7f-6a5b-4c3d-8e2f-${String(i).padStart(12, '0')}`,
      name: `f${i}.jpg`,
      mime: 'image/jpeg',
      size,
      sha256: String(i).padStart(64, '0'),
    })),
  };
}

describe('parseManifest', () => {
  it('acepta three-types.json', () => {
    const m = parseManifest(load('valid/three-types.json'));
    expect(m.files).toHaveLength(3);
  });

  it('rechaza propiedades extra con invalid_manifest', () => {
    expect(codeOf(() => parseManifest(load('invalid/extra-property.json')))).toBe('invalid_manifest');
  });

  it('rechaza basura con invalid_manifest', () => {
    expect(codeOf(() => parseManifest(null))).toBe('invalid_manifest');
    expect(codeOf(() => parseManifest('x'))).toBe('invalid_manifest');
  });

  it('11 archivos de 50 MB suman más de 500 MB: too_large', () => {
    expect(codeOf(() => parseManifest(manifestOf(Array(11).fill(52_428_800))))).toBe('too_large');
  });

  it('10 archivos de 50 MB están dentro del límite', () => {
    expect(() => parseManifest(manifestOf(Array(10).fill(52_428_800)))).not.toThrow();
  });

  it('un archivo de 52 428 801 bytes: too_large (R1)', () => {
    expect(codeOf(() => parseManifest(manifestOf([52_428_801])))).toBe('too_large');
  });
});
