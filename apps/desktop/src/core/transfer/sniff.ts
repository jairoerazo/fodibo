const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

function startsWith(head: Buffer, sig: number[], offset = 0): boolean {
  return head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b);
}

export function sniffOk(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'application/pdf':
      return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'image/heic':
      return head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.has(head.toString('latin1', 8, 12));
    case 'application/json':
      return true;
    default:
      return false;
  }
}
