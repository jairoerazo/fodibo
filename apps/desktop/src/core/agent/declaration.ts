import type { DeclEntry, DeclType, Declaration } from './types.js';

const TYPES: readonly DeclType[] = ['text', 'date', 'amount', 'iban', 'enum', 'boolean'];
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

export function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function validIban(s: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of n) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

export function validateEntry(key: string, raw: unknown): DeclEntry {
  if (!KEY_RE.test(key)) throw new Error(`Clave de declaración inválida: «${key}» (use minúsculas, dígitos y guion bajo)`);
  if (typeof raw !== 'object' || raw === null) throw new Error(`Entrada «${key}»: debe ser un objeto`);
  const { tipo, valor, moneda } = raw as Record<string, unknown>;
  if (typeof tipo !== 'string' || !TYPES.includes(tipo as DeclType)) {
    throw new Error(`Entrada «${key}»: tipo desconocido «${String(tipo)}»`);
  }
  const t = tipo as DeclType;
  if (t === 'boolean') {
    if (typeof valor !== 'boolean') throw new Error(`Entrada «${key}»: el valor debe ser booleano`);
    return { tipo: t, valor };
  }
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new Error(`Entrada «${key}»: el valor debe ser una cadena no vacía`);
  }
  if (t === 'date' && !validDate(valor)) {
    throw new Error(`Entrada «${key}»: fecha inválida «${valor}» (use AAAA-MM-DD)`);
  }
  if (t === 'amount') {
    if (!AMOUNT_RE.test(valor)) throw new Error(`Entrada «${key}»: importe inválido «${valor}»`);
    if (typeof moneda !== 'string' || !/^[A-Za-z]{3}$/.test(moneda)) {
      throw new Error(`Entrada «${key}»: falta la moneda de 3 letras`);
    }
    return { tipo: t, valor, moneda };
  }
  if (t === 'iban' && !validIban(valor)) throw new Error(`Entrada «${key}»: IBAN inválido «${valor}»`);
  return { tipo: t, valor };
}

export function loadDeclaration(json: unknown): Declaration {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('La declaración debe ser un objeto');
  }
  const out: Declaration = {};
  for (const [key, raw] of Object.entries(json)) out[key] = validateEntry(key, raw);
  return out;
}
