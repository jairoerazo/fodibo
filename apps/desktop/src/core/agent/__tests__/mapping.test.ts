import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatForField } from '../format.js';
import { responseSchema, validateAnswer, type FieldPlan } from '../mapping.js';
import type { Declaration, ObservedField, ObservedStep } from '../types.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const decl = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../test-portal/declaracion.json', import.meta.url)), 'utf8'),
) as Declaration;

const f = (o: Partial<ObservedField> & Pick<ObservedField, 'field_id' | 'type'>): ObservedField => ({
  label: o.field_id, help: '', required: false, value: '', ...o,
});
const step = (fields: ObservedField[]): ObservedStep => ({
  index: 1, total: 3, title: 'Paso', isSummary: false, fields, errors: [],
});
const mk = () => step([
  f({ field_id: 'f_text', type: 'text' }),
  f({ field_id: 'f_date', type: 'date' }),
  f({ field_id: 'f_amount', type: 'amount', required: true }),
  f({ field_id: 'f_select', type: 'select', options: ['soltero', 'casado'] }),
  f({ field_id: 'f_opt', type: 'amount' }),
]);
const good = () => ({
  f_text: { source: 'apellido' },
  f_date: { source: 'fecha_nacimiento' },
  f_amount: { source: 'salario_bruto' },
  f_select: { source: 'estado_civil', option: 'casado' },
  f_opt: { skip: true },
});
const plan = (s: ObservedStep, a: unknown): FieldPlan[] => {
  const r = validateAnswer(s, decl, a);
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

describe('validateAnswer', () => {
  it('respuesta correcta produce fills formateados', () => {
    const p = plan(mk(), good());
    expect(p[0]).toMatchObject({ action: 'fill', source: 'apellido', value: 'Müller' });
    expect(p[1]).toMatchObject({ action: 'fill', value: '07.03.1984' });
    expect(p[2]).toMatchObject({ action: 'fill', value: '85400.00' });
    expect(p[3]).toMatchObject({ action: 'fill', value: 'casado' });
    expect(p[4]).toMatchObject({ action: 'skip' });
  });

  it('field_id faltante, extra o forma desconocida -> ok:false', () => {
    const s = mk();
    const missing: Record<string, unknown> = good(); delete missing.f_text;
    expect(validateAnswer(s, decl, missing).ok).toBe(false);
    expect(validateAnswer(s, decl, { ...good(), extra: { skip: true } }).ok).toBe(false);
    expect(validateAnswer(s, decl, { ...good(), f_text: { foo: 1 } }).ok).toBe(false);
    expect(validateAnswer(s, decl, { ...good(), f_text: { source: 'apellido', valor: 'X' } }).ok).toBe(false);
    expect(validateAnswer(s, decl, { ...good(), f_text: { source: 'apellido', option: 'x' } }).ok).toBe(false);
    expect(validateAnswer(s, decl, { ...good(), f_text: { skip: false } }).ok).toBe(false);
    for (const bad of [null, undefined, 3, 'x', [], [good()]]) expect(validateAnswer(s, decl, bad).ok).toBe(false);
  });

  it('clave inexistente -> sin_dato', () => {
    const p = plan(mk(), { ...good(), f_text: { source: 'inventada' } });
    expect(p[0]).toMatchObject({ action: 'pending', reason: 'sin_dato' });
    expect((p[0] as { detail: string }).detail).toContain('clave inexistente: inventada');
  });

  it('claves del prototipo no cuentan como existentes', () => {
    const p = plan(mk(), { ...good(), f_text: { source: 'constructor' } });
    expect(p[0]).toMatchObject({ action: 'pending', reason: 'sin_dato' });
  });

  it('amount <- clave text -> tipo_incompatible', () => {
    const p = plan(mk(), { ...good(), f_amount: { source: 'apellido' } });
    expect(p[2]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
  });

  it('option fuera de lista o source no enum -> tipo_incompatible', () => {
    expect(plan(mk(), { ...good(), f_select: { source: 'estado_civil', option: 'viudo' } })[3])
      .toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
    expect(plan(mk(), { ...good(), f_select: { source: 'apellido', option: 'casado' } })[3])
      .toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
    expect(plan(mk(), { ...good(), f_select: { source: 'estado_civil' } })[3])
      .toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
  });

  it('pending con candidatos -> ambiguo con valores de la declaracion', () => {
    const p = plan(mk(), {
      ...good(),
      f_amount: {
        pending: 'dos primas',
        candidates: ['prima_seguro_medico_titular', 'prima_seguro_medico_familia', 'inventada'],
      },
    });
    expect(p[2]).toMatchObject({
      action: 'pending', reason: 'ambiguo', detail: 'dos primas',
      candidates: [
        { key: 'prima_seguro_medico_titular', valor: '4380.00' },
        { key: 'prima_seguro_medico_familia', valor: '11940.00' },
      ],
    });
  });

  it('pending con <2 candidatos -> sin_dato; mas de 5 candidatos invalido', () => {
    expect(plan(mk(), { ...good(), f_amount: { pending: 'x', candidates: ['salario_neto', 'zzz'] } })[2])
      .toMatchObject({ reason: 'sin_dato', candidates: [{ key: 'salario_neto', valor: '74210.00' }] });
    expect(plan(mk(), { ...good(), f_amount: { pending: 'x' } })[2]).toMatchObject({ reason: 'sin_dato', candidates: [] });
    expect(validateAnswer(mk(), decl, { ...good(), f_amount: { pending: 'x', candidates: Array(6).fill('a') } }).ok).toBe(false);
  });

  it('skip en obligatorio -> sin_dato', () => {
    expect(plan(mk(), { ...good(), f_amount: { skip: true } })[2]).toMatchObject({ action: 'pending', reason: 'sin_dato' });
  });

  it('valor previo igual -> keep, distinto -> valor_previo_distinto', () => {
    const s = mk();
    s.fields[2]!.value = "85'400.00";
    s.fields[3]!.value = 'casado';
    const p = plan(s, good());
    expect(p[2]).toMatchObject({ action: 'keep' });
    expect(p[3]).toMatchObject({ action: 'keep' });
    s.fields[2]!.value = '1.00';
    s.fields[3]!.value = 'soltero';
    const q = plan(s, good());
    expect(q[2]).toMatchObject({ action: 'pending', reason: 'valor_previo_distinto' });
    expect(q[3]).toMatchObject({ action: 'pending', reason: 'valor_previo_distinto' });
    // previo con respuesta skip/pending tambien queda pendiente
    expect(plan(s, { ...good(), f_amount: { skip: true } })[2]).toMatchObject({ reason: 'valor_previo_distinto' });
  });

  it('misma clave en campos de tipos distintos -> ambos tipo_incompatible', () => {
    const s = step([f({ field_id: 'a', type: 'amount' }), f({ field_id: 'b', type: 'text' })]);
    const p = plan(s, { a: { source: 'salario_bruto' }, b: { source: 'salario_bruto' } });
    expect(p[0]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
    expect(p[1]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
  });

  it('misma clave en un select y otro campo de tipo distinto -> ambos tipo_incompatible', () => {
    const s = step([
      f({ field_id: 'a', type: 'select', options: ['soltero', 'casado'] }),
      f({ field_id: 'b', type: 'text' }),
    ]);
    const p = plan(s, { a: { source: 'estado_civil', option: 'casado' }, b: { source: 'estado_civil' } });
    expect(p[0]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
    expect(p[1]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
  });

  it('checkbox solo con clave boolean', () => {
    const d2: Declaration = { ...decl, acepta: { tipo: 'boolean', valor: true } };
    const s = step([f({ field_id: 'c', type: 'checkbox' }), f({ field_id: 'd', type: 'checkbox' })]);
    const r = validateAnswer(s, d2, { c: { source: 'acepta' }, d: { source: 'salario_bruto' } });
    expect(r.ok && r.plan[0]).toMatchObject({ action: 'fill', value: 'true' });
    expect(r.ok && r.plan[1]).toMatchObject({ action: 'pending', reason: 'tipo_incompatible' });
  });
});

describe('propiedad de seguridad: ningun valor sale del modelo', () => {
  const smuggle = 'VALOR-INYECTADO-999';
  const s = mk();
  const keys = Object.keys(decl);
  const junk: unknown[] = [
    null, 0, 7, true, 'texto', [], [smuggle], {}, { source: smuggle }, { source: 5 }, { source: ['apellido'] },
    { source: { a: smuggle } }, { skip: smuggle }, { skip: true, valor: smuggle }, { pending: { x: smuggle } },
    { pending: smuggle, candidates: [smuggle, 'apellido', 1, null] }, { pending: smuggle, value: smuggle },
    { source: 'apellido', value: smuggle }, { source: 'apellido', valor: smuggle },
    { source: 'estado_civil', option: smuggle }, { source: 'estado_civil', option: ['casado'] },
    { source: 'estado_civil', option: 'casado', value: smuggle }, { source: '__proto__' },
    { source: 'toString' }, { source: 'salario_neto' }, { source: 'intereses_bancarios' },
    { source: smuggle }, { pending: smuggle }, { skip: true },
  ];
  const check = (st: ObservedStep, answer: unknown) => {
    const r = validateAnswer(st, decl, answer);
    if (!r.ok) return;
    expect(r.plan).toHaveLength(st.fields.length);
    for (const e of r.plan) {
      if (e.action === 'fill') {
        const entry = Object.hasOwn(decl, e.source) ? decl[e.source]! : undefined;
        const fromDecl = entry !== undefined && e.value === formatForField(entry, e.field);
        const fromOptions = (e.field.options ?? []).includes(e.value);
        expect(fromDecl || fromOptions).toBe(true);
        if (e.field.type === 'select') expect(fromOptions).toBe(true);
      }
      if (e.action === 'pending') {
        for (const c of e.candidates) {
          expect(Object.hasOwn(decl, c.key)).toBe(true);
          expect(c.valor).toBe(String(decl[c.key]!.valor));
        }
      }
      expect(JSON.stringify(e)).not.toContain(e.action === 'pending' ? '\u0000' : smuggle);
    }
  };

  it('recorre muchas respuestas validas, invalidas y adversariales', () => {
    let okCount = 0;
    const ids = s.fields.map((x) => x.field_id);
    for (let i = 0; i < 3000; i++) {
      const a: Record<string, unknown> = {};
      ids.forEach((id, j) => {
        const mode = (i + j * 7) % 3;
        a[id] = mode === 0
          ? junk[(i * 31 + j * 13) % junk.length]
          : mode === 1
            ? { source: keys[(i * 5 + j * 3) % keys.length], ...(j === 3 ? { option: s.fields[3]!.options![i % 3] ?? smuggle } : {}) }
            : { source: keys[(i + j) % keys.length] };
      });
      const r = validateAnswer(s, decl, a);
      if (r.ok) okCount++;
      check(s, a);
    }
    expect(okCount).toBeGreaterThan(100);
    for (const j of junk) check(s, j);
    // respuesta con propiedades extra a nivel superior
    check(s, { ...good(), [smuggle]: { source: 'apellido' } });
  });
});

describe('responseSchema', () => {
  const validate = new Ajv2020({ strict: false }).compile(responseSchema(mk(), decl));
  it('acepta la respuesta correcta', () => {
    expect(validate(good())).toBe(true);
    expect(validate({ ...good(), f_amount: { pending: 'x', candidates: ['salario_bruto'] } })).toBe(true);
  });
  it('rechaza field_id extra o faltante, option fuera de lista, option en no-select', () => {
    expect(validate({ ...good(), extra: { skip: true } })).toBe(false);
    const m: Record<string, unknown> = good(); delete m.f_text;
    expect(validate(m)).toBe(false);
    expect(validate({ ...good(), f_select: { source: 'estado_civil', option: 'viudo' } })).toBe(false);
    expect(validate({ ...good(), f_text: { source: 'apellido', option: 'x' } })).toBe(false);
    expect(validate({ ...good(), f_text: { source: 'apellido', valor: 'x' } })).toBe(false);
    expect(validate({ ...good(), f_amount: { pending: 'x', candidates: Array(6).fill('salario_bruto') } })).toBe(false);
  });
});

describe('responseSchema restringido a la declaración', () => {
  const ajv = new Ajv2020({ strict: false });
  const forms = (schema: object, id: string): Record<string, any>[] =>
    (schema as any).properties[id].oneOf as Record<string, any>[];

  it('source solo admite claves de tipo compatible', () => {
    const validate = ajv.compile(responseSchema(mk(), decl));
    expect(validate({ ...good(), f_amount: { source: 'apellido' } })).toBe(false); // text en amount
    expect(validate({ ...good(), f_amount: { source: 'no_existe' } })).toBe(false);
    expect(validate({ ...good(), f_amount: { source: 'Bruttolohn' } })).toBe(false); // etiqueta en vez de clave
    expect(validate({ ...good(), f_amount: { source: 'salario_neto' } })).toBe(true);
    expect(validate({ ...good(), f_select: { source: 'apellido', option: 'casado' } })).toBe(false);
    const amountKeys = forms(responseSchema(mk(), decl), 'f_amount').find((x) => x.required.includes('source'))!.properties.source.enum;
    expect(amountKeys).toEqual(Object.keys(decl).filter((k) => decl[k]!.tipo === 'amount'));
  });

  it('candidates solo admite claves compatibles', () => {
    const validate = ajv.compile(responseSchema(mk(), decl));
    expect(validate({ ...good(), f_amount: { pending: 'x', candidates: ['salario_bruto', 'salario_neto'] } })).toBe(true);
    expect(validate({ ...good(), f_amount: { pending: 'x', candidates: ['apellido'] } })).toBe(false);
    expect(validate({ ...good(), f_amount: { pending: 'x', candidates: ['a'] } })).toBe(false);
  });

  it('la forma pending va primero en cada oneOf', () => {
    const schema = responseSchema(mk(), decl);
    for (const id of ['f_text', 'f_date', 'f_amount', 'f_select', 'f_opt']) {
      expect(forms(schema, id)[0]!.required).toEqual(['pending']);
    }
  });

  it('sin claves compatibles: solo pending y skip, y candidates vacío', () => {
    const s = step([f({ field_id: 'f_bool', type: 'checkbox', required: true })]);
    const schema = responseSchema(s, decl); // la declaración de prueba no tiene booleanos
    expect(forms(schema, 'f_bool').map((x) => x.required)).toEqual([['pending'], ['skip']]);
    const validate = ajv.compile(schema);
    expect(validate({ f_bool: { source: 'apellido' } })).toBe(false);
    expect(validate({ f_bool: { pending: 'sin dato' } })).toBe(true);
    expect(validate({ f_bool: { pending: 'sin dato', candidates: [] } })).toBe(true);
    expect(validate({ f_bool: { pending: 'sin dato', candidates: ['apellido'] } })).toBe(false);
  });

  it('select sin opciones: sin forma source+option', () => {
    const s = step([f({ field_id: 'f_sel', type: 'select', options: [] }), f({ field_id: 'f_sel2', type: 'select' })]);
    const schema = responseSchema(s, decl);
    for (const id of ['f_sel', 'f_sel2']) expect(forms(schema, id).map((x) => x.required)).toEqual([['pending'], ['skip']]);
    expect(ajv.compile(schema)({ f_sel: { pending: 'x' }, f_sel2: { skip: true } })).toBe(true);
  });

  it('validateAnswer sigue siendo la puerta: una respuesta fuera del esquema se rechaza o queda pendiente', () => {
    const s = mk();
    const a = { ...good(), f_amount: { source: 'apellido' } };
    expect(ajv.compile(responseSchema(s, decl))(a)).toBe(false);
    const v = validateAnswer(s, decl, a);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.plan.find((p) => p.field.field_id === 'f_amount')!.action).toBe('pending');
  });
});
