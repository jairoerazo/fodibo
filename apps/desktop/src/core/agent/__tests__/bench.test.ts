import { describe, expect, it } from 'vitest';
import { accept, parseExpected, scoreRun, type ExpectedField, type RunScore } from '../bench.js';
import type { Declaration, FieldOutcome, FieldResult } from '../types.js';

const decl: Declaration = {
  vorname: { tipo: 'text', valor: 'Anna' },
  zivilstand: { tipo: 'enum', valor: 'marié' },
  bruttolohn_jahr: { tipo: 'amount', valor: '85400.00', moneda: 'CHF' },
  nettolohn_jahr: { tipo: 'amount', valor: '74210.00', moneda: 'CHF' },
  krankenkasse_praemie_hauptperson: { tipo: 'amount', valor: '4380.00', moneda: 'CHF' },
  krankenkasse_praemie_familie: { tipo: 'amount', valor: '11940.00', moneda: 'CHF' },
  iban: { tipo: 'iban', valor: 'CH9300762011623852957' },
};

const expected: Record<string, ExpectedField> = {
  '1/Vorname': { source: 'vorname' },
  '1/Zivilstand': { source: 'zivilstand', option: 'verheiratet' },
  '2/Bruttolohn': { source: 'bruttolohn_jahr' },
  '2/AHV/IV/EO-Beiträge': { pending: true },
  '3/Krankenkassenprämien': { pending: true },
  '4/IBAN': { source: 'iban' },
  '4/Zweites Bankkonto': { empty: true },
};

const r = (step: number, label: string, outcome: FieldOutcome): FieldResult => ({
  step,
  stepTitle: `Paso ${step}`,
  field_id: `c${step}`,
  label,
  required: true,
  outcome,
});
const filled = (source: string, written: string): FieldOutcome => ({ kind: 'filled', source, written });
const pending: FieldOutcome = { kind: 'pending', reason: 'ambiguo', candidates: [] };

function perfect(): FieldResult[] {
  return [
    r(1, 'Vorname', filled('vorname', 'Anna')),
    r(1, 'Zivilstand', filled('zivilstand', 'verheiratet')),
    r(2, 'Bruttolohn', filled('bruttolohn_jahr', '85400.00')),
    r(2, 'AHV/IV/EO-Beiträge', { kind: 'pending', reason: 'sin_dato', candidates: [] }),
    r(3, 'Krankenkassenprämien', pending),
    r(4, 'IBAN', filled('iban', 'CH9300762011623852957')),
    r(4, 'Zweites Bankkonto', { kind: 'skipped' }),
  ];
}
const options = { '1/Zivilstand': ['ledig', 'verheiratet', 'geschieden'] };

function replace(results: FieldResult[], label: string, outcome: FieldOutcome): FieldResult[] {
  return results.map((x) => (x.label === label ? { ...x, outcome } : x));
}

describe('scoreRun', () => {
  it('un resultado perfecto: correct === withData y nada equivocado', () => {
    const s = scoreRun(perfect(), expected, decl, 0, options);
    expect(s.withData).toBe(4);
    expect(s.correct).toBe(4);
    expect(s.wrong).toBe(0);
    expect(s.invented).toBe(0);
    expect(s.pendingOk).toBe(2);
    expect(s.pendingMissed).toBe(0);
    expect(s.blockedSubmits).toBe(0);
    expect(s.failures).toEqual([]);
  });

  it('prefilled_ok cuenta como correcto', () => {
    const s = scoreRun(replace(perfect(), 'Vorname', { kind: 'prefilled_ok' }), expected, decl, 0, options);
    expect(s.correct).toBe(4);
  });

  it('asignar nettolohn_jahr a «Bruttolohn» cuenta como equivocado', () => {
    const s = scoreRun(replace(perfect(), 'Bruttolohn', filled('nettolohn_jahr', '74210.00')), expected, decl, 0, options);
    expect(s.correct).toBe(3);
    expect(s.wrong).toBe(1);
    expect(s.invented).toBe(0);
    expect(s.failures).toEqual([
      { key: '2/Bruttolohn', expected: { source: 'bruttolohn_jahr' }, got: { kind: 'filled', source: 'nettolohn_jahr', written: '74210.00' } },
    ]);
  });

  it('rellenar el campo ambiguo cuenta como equivocado y accept falla', () => {
    const s = scoreRun(replace(perfect(), 'Krankenkassenprämien', filled('krankenkasse_praemie_hauptperson', '4380.00')), expected, decl, 0, options);
    expect(s.wrong).toBe(1);
    expect(s.pendingOk).toBe(1);
    expect(s.pendingMissed).toBe(1);
    expect(s.correct).toBe(4);
    const a = accept([s, s, s]);
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/Krankenkassenprämien/);
  });

  it('rellenar un campo que debe quedar vacío cuenta como equivocado', () => {
    const s = scoreRun(replace(perfect(), 'Zweites Bankkonto', filled('iban', 'CH93 0076 2011 6238 5295 7')), expected, decl, 0, options);
    expect(s.wrong).toBe(1);
  });

  it('un pending donde había dato baja correct sin subir wrong', () => {
    const s = scoreRun(replace(perfect(), 'Bruttolohn', pending), expected, decl, 0, options);
    expect(s.correct).toBe(3);
    expect(s.wrong).toBe(0);
    expect(s.failures.map((f) => f.key)).toEqual(['2/Bruttolohn']);
  });

  it('un written manipulado cuenta como inventado', () => {
    const s = scoreRun(replace(perfect(), 'Bruttolohn', filled('bruttolohn_jahr', '99999.00')), expected, decl, 0, options);
    expect(s.invented).toBe(1);
    expect(accept([s]).ok).toBe(false);
  });

  it('el formato no cuenta como inventado (normalizado) y una opción de la página tampoco', () => {
    const s = scoreRun(replace(perfect(), 'IBAN', filled('iban', 'ch9300762011623852957')), expected, decl, 0, options);
    expect(s.invented).toBe(0);
    const s2 = scoreRun(perfect(), expected, decl, 0, {});
    expect(s2.invented).toBe(1); // «verheiratet» sin la lista de opciones no se puede justificar
  });

  it('un campo esperado sin resultado no es correcto y aparece en los fallos', () => {
    const s = scoreRun(perfect().filter((x) => x.label !== 'IBAN'), expected, decl, 0, options);
    expect(s.correct).toBe(3);
    expect(s.wrong).toBe(0);
    expect(s.failures.map((f) => f.key)).toEqual(['4/IBAN']);
  });

  it('select: la fuente correcta con otra opción escrita cuenta como equivocado', () => {
    const s = scoreRun(replace(perfect(), 'Zivilstand', filled('zivilstand', 'ledig')), expected, decl, 0, options);
    expect(s.correct).toBe(3);
    expect(s.wrong).toBe(1);
    expect(s.invented).toBe(0); // «ledig» es una opción existente de la página
    expect(s.failures.map((f) => f.key)).toEqual(['1/Zivilstand']);
  });

  it('select: la fuente y la opción esperadas cuentan como correcto', () => {
    const s = scoreRun(replace(perfect(), 'Zivilstand', filled('zivilstand', 'verheiratet')), expected, decl, 0, options);
    expect(s.correct).toBe(4);
    expect(s.wrong).toBe(0);
  });

  it('select: la opción correcta con otra fuente cuenta como equivocado', () => {
    const s = scoreRun(replace(perfect(), 'Zivilstand', filled('vorname', 'verheiratet')), expected, decl, 0, options);
    expect(s.correct).toBe(3);
    expect(s.wrong).toBe(1);
  });

  it('copia el número de envíos bloqueados', () => {
    const s = scoreRun(perfect(), expected, decl, 2, options);
    expect(s.blockedSubmits).toBe(2);
    expect(accept([s]).ok).toBe(false);
  });
});

const score = (o: Partial<RunScore>): RunScore => ({
  withData: 10,
  correct: 10,
  wrong: 0,
  invented: 0,
  pendingOk: 2,
  pendingMissed: 0,
  blockedSubmits: 0,
  failures: [],
  ...o,
});

describe('accept', () => {
  it('9/10 correctos y 1 equivocado pasa', () => {
    const a = accept([score({}), score({ correct: 9, wrong: 1 }), score({ correct: 9, wrong: 1 })]);
    expect(a).toEqual({ ok: true, reasons: [] });
  });
  it('2 equivocados en una ejecución falla', () => {
    const a = accept([score({}), score({ correct: 8, wrong: 2 }), score({})]);
    expect(a.ok).toBe(false);
    expect(a.reasons).toHaveLength(2); // < 90 % y > 1 equivocado
    expect(a.reasons.every((x) => x.startsWith('ejecución 2'))).toBe(true);
  });
  it('8/10 correctos sin equivocados falla por el 90 %', () => {
    expect(accept([score({ correct: 8 })]).ok).toBe(false);
  });
  it('un inventado o un envío bloqueado falla', () => {
    expect(accept([score({ invented: 1 })]).ok).toBe(false);
    expect(accept([score({ blockedSubmits: 1 })]).ok).toBe(false);
  });
  it('sin ejecuciones no se acepta', () => {
    expect(accept([]).ok).toBe(false);
  });
});

describe('parseExpected', () => {
  it('lee esperado.json separando solo por la primera «/»', () => {
    const m = parseExpected({ '2/AHV/IV/EO-Beiträge': { source: 'x' }, '3/A': { pending: true }, '4/B': { empty: true } });
    expect(m.get('2/AHV/IV/EO-Beiträge')).toEqual({ step: 2, label: 'AHV/IV/EO-Beiträge', expected: { source: 'x' } });
    expect(m.size).toBe(3);
  });
  it('lee la opción esperada de un select', () => {
    const m = parseExpected({ '1/Zivilstand': { source: 'zivilstand', option: 'verheiratet' } });
    expect(m.get('1/Zivilstand')?.expected).toEqual({ source: 'zivilstand', option: 'verheiratet' });
    expect(() => parseExpected({ '1/Zivilstand': { source: 'zivilstand', option: 3 } })).toThrow();
    expect(() => parseExpected({ '1/Zivilstand': { source: 'zivilstand', option: '' } })).toThrow();
  });
  it('rechaza claves o valores mal formados', () => {
    expect(() => parseExpected({ sinpaso: { pending: true } })).toThrow();
    expect(() => parseExpected({ '1/A': { nada: 1 } })).toThrow();
  });
});
