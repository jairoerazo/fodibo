import { describe, expect, it } from 'vitest';
import { sniffOk } from '../sniff.js';

const heic = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)]);

describe('sniffOk', () => {
  it('JPEG', () => expect(sniffOk('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(true));
  it('PNG', () =>
    expect(sniffOk('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true));
  it('PDF', () => expect(sniffOk('application/pdf', Buffer.from('%PDF-1.4\n'))).toBe(true));
  it.each(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])('HEIC marca %s', (b) =>
    expect(sniffOk('image/heic', heic(b))).toBe(true),
  );
  it('JSON siempre true', () => {
    expect(sniffOk('application/json', Buffer.alloc(0))).toBe(true);
    expect(sniffOk('application/json', Buffer.from('{}'))).toBe(true);
  });
  it('PNG con cabecera JPEG es false', () =>
    expect(sniffOk('image/png', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false));
  it('HEIC con marca avif es false', () => expect(sniffOk('image/heic', heic('avif'))).toBe(false));
  it('búfer vacío es false salvo JSON', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/heic', 'application/pdf']) {
      expect(sniffOk(m, Buffer.alloc(0))).toBe(false);
    }
  });
  it('mime desconocido es false', () => expect(sniffOk('text/plain', Buffer.from('hola'))).toBe(false));
});
