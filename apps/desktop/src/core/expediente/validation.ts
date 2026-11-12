import { validDate, validIban, validateEntry } from '../agent/index.js';
import type { Concept } from '../agent/index.js';
import type { DeclEntry } from '../agent/types.js';
import { ExpedienteError } from './errors.js';

const MAX_TEXT = 200;
const DATE_CH_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// Miles con ', ’ o espacio (también no-break y estrecho); un único separador decimal de 1–2 cifras.
const AMOUNT_IN_RE = /^(-?)(\d{1,3}(?:['’   ]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/;

function invalid(message: string): never {
  throw new ExpedienteError('invalid_input', message, { field: 'valor' });
}

function str(valor: unknown, what: string): string {
  if (typeof valor !== 'string') invalid(`${what} no válido`);
  return valor as string;
}

function normalizeAmount(raw: string): string {
  const m = AMOUNT_IN_RE.exec(raw.trim());
  if (!m) invalid('Importe no válido');
  const [, sign, int, dec = ''] = m as RegExpExecArray;
  const digits = int.replace(/\D/g, '');
  const out = `${digits}.${dec.padEnd(2, '0')}`;
  return sign && Number(out) !== 0 ? `-${out}` : out;
}

function normalizeCurrency(moneda: unknown): string {
  if (moneda === undefined) return 'CHF';
  if (typeof moneda !== 'string' || !/^[A-Za-z]{3}$/.test(moneda)) {
    throw new ExpedienteError('invalid_input', 'Moneda no válida', { field: 'moneda' });
  }
  return moneda.toUpperCase();
}

/** Convierte la entrada de la interfaz en la forma guardada de la spec §6.3; lanza `invalid_input` si no es válida. */
export function normalizeValue(concept: Concept, input: { valor: unknown; moneda?: unknown }): DeclEntry {
  const { valor, moneda } = input;
  if (concept.tipo !== 'amount' && moneda !== undefined) {
    throw new ExpedienteError('invalid_input', 'Este tipo de valor no admite moneda', { field: 'moneda' });
  }
  let entry: DeclEntry;
  switch (concept.tipo) {
    case 'text': {
      const s = str(valor, 'Texto').normalize('NFC').trim();
      if (s === '' || [...s].length > MAX_TEXT || /\p{Cc}/u.test(s)) invalid('Texto no válido');
      entry = { tipo: 'text', valor: s };
      break;
    }
    case 'date': {
      const s = str(valor, 'Fecha').trim();
      const m = DATE_CH_RE.exec(s);
      const iso = m ? `${m[3]}-${m[2]}-${m[1]}` : s;
      if (!validDate(iso)) invalid('Fecha no válida');
      entry = { tipo: 'date', valor: iso };
      break;
    }
    case 'amount':
      entry = { tipo: 'amount', valor: normalizeAmount(str(valor, 'Importe')), moneda: normalizeCurrency(moneda) };
      break;
    case 'iban': {
      const s = str(valor, 'IBAN').replace(/\s+/g, '').toUpperCase();
      if (!validIban(s)) invalid('IBAN no válido');
      entry = { tipo: 'iban', valor: s };
      break;
    }
    case 'enum': {
      const s = str(valor, 'Valor');
      if (!concept.values?.includes(s)) invalid('Valor no admitido');
      entry = { tipo: 'enum', valor: s };
      break;
    }
    case 'boolean':
      if (typeof valor !== 'boolean') invalid('Valor no válido');
      entry = { tipo: 'boolean', valor: valor as boolean };
      break;
  }
  try {
    return validateEntry(concept.id, entry);
  } catch {
    return invalid('Valor no válido');
  }
}
