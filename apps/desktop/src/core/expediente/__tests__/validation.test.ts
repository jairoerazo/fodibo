import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../agent/index.js';
import type { Concept } from '../../agent/index.js';
import { ExpedienteError } from '../errors.js';
import { normalizeValue } from '../validation.js';

const mk = (tipo: Concept['tipo'], extra: Partial<Concept> = {}): Concept => ({ id: 'test_feld', tipo, labels: [], ...extra });
const zivilstand = CONCEPTS.find((c) => c.id === 'zivilstand')!;
const REJECT = Symbol('reject');

const cases: [string, Concept, unknown, unknown][] = [
  ['text recorta', mk('text'), '  Müller  ', 'Müller'],
  ['text vacío', mk('text'), '', REJECT],
  ['text control', mk('text'), 'a\u0007b', REJECT],
  ['text 201', mk('text'), 'a'.repeat(201), REJECT],
  ['text NFC', mk('text'), 'Müller', 'Müller'],
  ['date CH', mk('date'), '07.03.1984', '1984-03-07'],
  ['date ISO', mk('date'), '1984-03-07', '1984-03-07'],
  ['date inexistente', mk('date'), '31.02.2024', REJECT],
  ['date corta', mk('date'), '7.3.84', REJECT],
  ['amount apóstrofo', mk('amount'), "85'400.00", '85400.00'],
  ['amount ’ y coma', mk('amount'), '85’400,5', '85400.50'],
  ['amount espacio', mk('amount'), '85 400', '85400.00'],
  ['amount no-break', mk('amount'), '85 400', '85400.00'],
  ['amount negativo', mk('amount'), '-12.3', '-12.30'],
  ['amount 3 decimales', mk('amount'), '12.345', REJECT],
  ['amount con divisa', mk('amount'), 'CHF 100', REJECT],
  ['amount ambiguo', mk('amount'), '1,234.50', REJECT],
  ['iban con espacios', mk('iban'), 'ch93 0076 2011 6238 5295 7', 'CH9300762011623852957'],
  ['iban dígito malo', mk('iban'), 'CH9300762011623852958', REJECT],
  ['enum válido', zivilstand, 'verheiratet', 'verheiratet'],
  ['enum mayúscula', zivilstand, 'Verheiratet', REJECT],
  ['enum ajeno', zivilstand, 'marié', REJECT],
  ['boolean true', mk('boolean'), true, true],
  ['boolean cadena', mk('boolean'), 'true', REJECT],
  ['text no cadena', mk('text'), 5, REJECT],
];

describe('normalizeValue', () => {
  it.each(cases)('%s', (_n, concept, input, expected) => {
    if (expected === REJECT) {
      try {
        normalizeValue(concept, { valor: input });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ExpedienteError);
        expect((e as ExpedienteError).code).toBe('invalid_input');
        expect((e as ExpedienteError).details).toEqual({ field: 'valor' });
        if (String(input).length > 1) expect((e as ExpedienteError).message).not.toContain(String(input));
      }
    } else {
      expect(normalizeValue(concept, { valor: input }).valor).toBe(expected);
    }
  });

  it('moneda por defecto, mayúsculas y rechazo', () => {
    expect(normalizeValue(mk('amount'), { valor: '1' }).moneda).toBe('CHF');
    expect(normalizeValue(mk('amount'), { valor: '1', moneda: 'chf' }).moneda).toBe('CHF');
    expect(() => normalizeValue(mk('amount'), { valor: '1', moneda: 'CHFX' })).toThrow(ExpedienteError);
  });

  it('moneda solo en importes', () => {
    expect(() => normalizeValue(mk('text'), { valor: 'a', moneda: 'CHF' })).toThrow(ExpedienteError);
  });

  it('cero negativo no conserva signo', () => {
    expect(normalizeValue(mk('amount'), { valor: '-0' }).valor).toBe('0.00');
  });
});
