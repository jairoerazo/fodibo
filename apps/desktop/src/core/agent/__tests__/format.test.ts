import { describe, expect, it } from 'vitest';
import { formatForField, normalize, typeCompatible } from '../format.js';
import type { ObservedField } from '../types.js';

const field = (type: ObservedField['type']): ObservedField => ({
  field_id: 'f', label: 'F', help: '', type, required: true, value: '',
});

describe('formatForField', () => {
  it('fecha a TT.MM.JJJJ', () => {
    expect(formatForField({ tipo: 'date', valor: '1984-03-07' }, field('date'))).toBe('07.03.1984');
  });
  it('importe con 2 decimales', () => {
    expect(formatForField({ tipo: 'amount', valor: '85400', moneda: 'CHF' }, field('amount'))).toBe('85400.00');
    expect(formatForField({ tipo: 'amount', valor: '7056.5', moneda: 'CHF' }, field('amount'))).toBe('7056.50');
  });
  it('IBAN en grupos de 4', () => {
    expect(formatForField({ tipo: 'iban', valor: 'CH9300762011623852957' }, field('iban'))).toBe('CH93 0076 2011 6238 5295 7');
  });
  it('checkbox y texto', () => {
    expect(formatForField({ tipo: 'boolean', valor: true }, field('checkbox'))).toBe('true');
    expect(formatForField({ tipo: 'boolean', valor: false }, field('checkbox'))).toBe('false');
    expect(formatForField({ tipo: 'text', valor: 'Anna' }, field('text'))).toBe('Anna');
    expect(formatForField({ tipo: 'enum', valor: 'casado' }, field('select'))).toBe('casado');
  });
});

describe('normalize', () => {
  it('importe', () => expect(normalize('amount', "85'400.00")).toBe('85400.00'));
  it('iban', () => expect(normalize('iban', 'ch93 0076 2011 6238 5295 7')).toBe('CH9300762011623852957'));
  it('texto recorta', () => expect(normalize('text', '  Anna ')).toBe('Anna'));
});

describe('typeCompatible', () => {
  it('tabla', () => {
    expect(typeCompatible('select', 'enum')).toBe(true);
    expect(typeCompatible('checkbox', 'boolean')).toBe(true);
    expect(typeCompatible('amount', 'text')).toBe(false);
    expect(typeCompatible('text', 'enum')).toBe(false);
  });
});
