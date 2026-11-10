import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadDeclaration } from '../declaration.js';

const file = new URL('../../../../test-portal/declaracion.json', import.meta.url);

describe('loadDeclaration', () => {
  it('carga la declaración de prueba', () => {
    const decl = loadDeclaration(JSON.parse(readFileSync(file, 'utf8')));
    expect(decl.numero_avs).toEqual({ tipo: 'text', valor: '756.1234.5678.97' });
    expect(decl.iban.tipo).toBe('iban');
    expect(decl.verpflegungsmehrkosten).toBeUndefined();
  });

  it('rechaza fecha inválida', () => {
    expect(() => loadDeclaration({ f: { tipo: 'date', valor: '2026-02-30' } })).toThrow(/fecha/i);
  });
  it('rechaza IBAN con control incorrecto', () => {
    expect(() => loadDeclaration({ i: { tipo: 'iban', valor: 'CH9400762011623852957' } })).toThrow(/IBAN/);
  });
  it('rechaza amount con apóstrofo', () => {
    expect(() => loadDeclaration({ a: { tipo: 'amount', valor: "85'400", moneda: 'CHF' } })).toThrow(/importe/i);
  });
  it('rechaza amount sin moneda', () => {
    expect(() => loadDeclaration({ a: { tipo: 'amount', valor: '85400.00' } })).toThrow(/moneda/i);
  });
  it('rechaza clave inválida', () => {
    expect(() => loadDeclaration({ Salario: { tipo: 'text', valor: 'x' } })).toThrow(/clave/i);
  });
  it('rechaza boolean como cadena', () => {
    expect(() => loadDeclaration({ b: { tipo: 'boolean', valor: 'true' } })).toThrow(/booleano/i);
  });
  it('rechaza text vacío y tipo desconocido', () => {
    expect(() => loadDeclaration({ t: { tipo: 'text', valor: '' } })).toThrow(/cadena/i);
    expect(() => loadDeclaration({ t: { tipo: 'foo', valor: 'x' } })).toThrow(/tipo/i);
    expect(() => loadDeclaration(null)).toThrow(/objeto/i);
  });
});
