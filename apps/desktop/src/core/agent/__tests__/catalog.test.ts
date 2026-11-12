import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONCEPTS, normalizeLabel, resolveFromCatalog, type Concept } from '../catalog.js';
import { parseExpected } from '../bench.js';
import type { Declaration, FieldType, ObservedField, ObservedStep } from '../types.js';

const f = (o: Partial<ObservedField> & Pick<ObservedField, 'field_id' | 'type' | 'label'>): ObservedField => ({
  help: '', required: true, value: '', ...o,
});
const step = (fields: ObservedField[]): ObservedStep => ({ index: 1, total: 2, title: 'P', isSummary: false, fields, errors: [] });
const amount = (valor: string) => ({ tipo: 'amount' as const, valor, moneda: 'CHF' });

const concepts: Concept[] = [
  { id: 'bruttolohn_jahr', tipo: 'amount', labels: ['Bruttolohn'] },
  { id: 'krankenkasse_praemie', tipo: 'amount', labels: ['Krankenkassenprämien'], variants: true },
  { id: 'verpflegungsmehrkosten', tipo: 'amount', labels: ['Verpflegungsmehrkosten'] },
  { id: 'zivilstand', tipo: 'enum', labels: ['Zivilstand'] },
  { id: 'iban', tipo: 'iban', labels: ['IBAN'] },
];
const decl: Declaration = {
  bruttolohn_jahr: amount('85400.00'),
  krankenkasse_praemie_hauptperson: amount('4380.00'),
  krankenkasse_praemie_familie: amount('11940.00'),
  zivilstand: { tipo: 'enum', valor: 'verheiratet' },
  iban: { tipo: 'iban', valor: 'CH9300762011623852957' },
};

describe('normalizeLabel', () => {
  it('ignora mayúsculas, espacios, «:» o «*» finales y la forma Unicode', () => {
    expect(normalizeLabel('  Brutto Lohn *: ')).toBe('brutto lohn');
    expect(normalizeLabel('Säule 3a')).toBe(normalizeLabel('Säule 3a'));
  });
});

describe('resolveFromCatalog', () => {
  it('asigna la clave del concepto cuando la etiqueta coincide', () => {
    const r = resolveFromCatalog(step([f({ field_id: 'x', type: 'amount', label: 'bruttolohn:' })]), decl, concepts);
    expect(r.answer).toEqual({ x: { source: 'bruttolohn_jahr' } });
    expect([...r.resolved]).toEqual(['x']);
  });

  it('varias variantes del concepto en la declaración: pendiente con todas como candidatas', () => {
    const r = resolveFromCatalog(step([f({ field_id: 'k', type: 'amount', label: 'Krankenkassenprämien' })]), decl, concepts);
    expect(r.answer.k).toEqual({
      pending: expect.any(String),
      candidates: ['krankenkasse_praemie_familie', 'krankenkasse_praemie_hauptperson'],
    });
  });

  it('una sola variante: se asigna', () => {
    const d: Declaration = { krankenkasse_praemie_hauptperson: amount('4380.00') };
    const r = resolveFromCatalog(step([f({ field_id: 'k', type: 'amount', label: 'Krankenkassenprämien' })]), d, concepts);
    expect(r.answer.k).toEqual({ source: 'krankenkasse_praemie_hauptperson' });
  });

  it('sin variantes, solo cuenta la clave exacta: «iban» no incluye «iban_zweites_konto»', () => {
    const d: Declaration = { ...decl, iban_zweites_konto: { tipo: 'iban', valor: 'CH5604835012345678009' } };
    const r = resolveFromCatalog(step([f({ field_id: 'i', type: 'iban', label: 'IBAN' })]), d, concepts);
    expect(r.answer.i).toEqual({ source: 'iban' });
  });

  it('concepto conocido sin dato: pendiente si es obligatorio, omitido si es opcional', () => {
    const s = step([
      f({ field_id: 'r', type: 'amount', label: 'Verpflegungsmehrkosten' }),
      f({ field_id: 'o', type: 'amount', label: 'Verpflegungsmehrkosten', required: false }),
    ]);
    const r = resolveFromCatalog(s, decl, concepts);
    expect(r.answer.r).toEqual({ pending: expect.any(String), candidates: [] });
    expect(r.answer.o).toEqual({ skip: true });
  });

  it('la clave del concepto con otro tipo en la declaración no cuenta como dato', () => {
    const d: Declaration = { bruttolohn_jahr: { tipo: 'text', valor: 'mucho' } };
    const r = resolveFromCatalog(step([f({ field_id: 'x', type: 'amount', label: 'Bruttolohn' })]), d, concepts);
    expect(r.answer.x).toEqual({ pending: expect.any(String), candidates: [] });
  });

  it('etiqueta desconocida o campo de tipo incompatible con el concepto: queda para el modelo', () => {
    const s = step([
      f({ field_id: 'u', type: 'amount', label: 'Liegenschaftsunterhalt' }),
      f({ field_id: 't', type: 'text', label: 'Bruttolohn' }),
    ]);
    const r = resolveFromCatalog(s, decl, concepts);
    expect(r.answer).toEqual({});
    expect(r.resolved.size).toBe(0);
  });

  it('select: elige la opción igual al valor (sin distinguir mayúsculas); si ninguna coincide, queda para el modelo', () => {
    const sel = (field_id: string, options: string[]) => f({ field_id, type: 'select' as FieldType, label: 'Zivilstand', options });
    const r = resolveFromCatalog(step([sel('z', ['ledig', 'Verheiratet'])]), decl, concepts);
    expect(r.answer.z).toEqual({ source: 'zivilstand', option: 'Verheiratet' });
    const d: Declaration = { zivilstand: { tipo: 'enum', valor: 'marié' } };
    expect(resolveFromCatalog(step([sel('z', ['ledig', 'verheiratet'])]), d, concepts).resolved.size).toBe(0);
  });

  it('una misma clave para dos campos del paso: ninguno se resuelve y decide el modelo', () => {
    const s = step([
      f({ field_id: 'a', type: 'amount', label: 'Bruttolohn' }),
      f({ field_id: 'b', type: 'amount', label: 'Bruttolohn' }),
    ]);
    expect(resolveFromCatalog(s, decl, concepts).resolved.size).toBe(0);
  });

  it('una etiqueta en dos conceptos del catálogo: queda para el modelo', () => {
    const dup: Concept[] = [...concepts, { id: 'otro', tipo: 'amount', labels: ['Bruttolohn'] }];
    expect(resolveFromCatalog(step([f({ field_id: 'x', type: 'amount', label: 'Bruttolohn' })]), decl, dup).resolved.size).toBe(0);
  });
});

describe('CONCEPTS', () => {
  it('ids y etiquetas únicos', () => {
    expect(new Set(CONCEPTS.map((c) => c.id)).size).toBe(CONCEPTS.length);
    const labels = CONCEPTS.flatMap((c) => c.labels.map(normalizeLabel));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('con el portal de prueba resuelve todos los campos como indica esperado.json', () => {
    const root = new URL('../../../../test-portal/', import.meta.url);
    const read = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(n, root)), 'utf8')) as unknown;
    const d = read('declaracion.json') as Declaration;
    const expected = parseExpected(read('esperado.json'));
    const html = readFileSync(fileURLToPath(new URL('index.html', root)), 'utf8');
    const re = /<label for="(p(\d)_f\d)">([^<]+)<\/label>\s*<(input|select)([^>]*)>([\s\S]*?)<small/g;
    const byStep = new Map<number, ObservedField[]>();
    for (const m of html.matchAll(re)) {
      const type = /data-type="(\w+)"/.exec(m[5]!)![1] as FieldType;
      const options = m[4] === 'select' ? [...m[6]!.matchAll(/<option value="([^"]+)">/g)].map((o) => o[1]!) : undefined;
      const list = byStep.get(Number(m[2])) ?? [];
      list.push(f({ field_id: m[1]!, type, label: m[3]!, required: /required/.test(m[5]!), ...(options ? { options } : {}) }));
      byStep.set(Number(m[2]), list);
    }
    let checked = 0;
    for (const [n, fields] of byStep) {
      const r = resolveFromCatalog({ ...step(fields), index: n }, d);
      for (const field of fields) {
        const exp = expected.get(`${n}/${field.label}`)!.expected;
        const got = r.answer[field.field_id] as Record<string, unknown>;
        expect(r.resolved.has(field.field_id), field.label).toBe(true);
        if ('source' in exp) expect(got, field.label).toEqual({ source: exp.source, ...(exp.option ? { option: exp.option } : {}) });
        else if ('pending' in exp) expect(got, field.label).toMatchObject({ pending: expect.any(String) });
        else expect(got, field.label).toEqual({ skip: true });
        checked++;
      }
    }
    expect(checked).toBe(17);
  });
});
