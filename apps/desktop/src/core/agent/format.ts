import type { DeclEntry, DeclType, FieldType, ObservedField } from './types.js';

export function formatForField(entry: DeclEntry, field: ObservedField): string {
  const v = entry.valor;
  if (field.type === 'checkbox') return v === true || v === 'true' ? 'true' : 'false';
  const s = String(v);
  switch (entry.tipo) {
    case 'date': {
      const [y, m, d] = s.split('-');
      return `${d}.${m}.${y}`;
    }
    case 'amount':
      return Number(s).toFixed(2);
    case 'iban':
      return normalize('iban', s).replace(/(.{4})(?=.)/g, '$1 ');
    default:
      return s;
  }
}

export function normalize(type: FieldType, s: string): string {
  if (type === 'amount') return s.replace(/[\s'’]/g, '');
  if (type === 'iban') return s.replace(/[\s'’]/g, '').toUpperCase();
  return s.trim();
}

const COMPAT: Record<FieldType, DeclType> = {
  text: 'text',
  date: 'date',
  amount: 'amount',
  iban: 'iban',
  select: 'enum',
  checkbox: 'boolean',
};

export function typeCompatible(field: FieldType, decl: DeclType): boolean {
  return COMPAT[field] === decl;
}
