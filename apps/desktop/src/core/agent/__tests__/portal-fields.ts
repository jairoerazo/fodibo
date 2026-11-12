import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseExpected } from '../bench.js';
import type { Declaration, FieldType, ObservedField, ObservedStep } from '../types.js';

const root = new URL('../../../../test-portal/', import.meta.url);
const read = (n: string): string => readFileSync(fileURLToPath(new URL(n, root)), 'utf8');

export const portalDeclaration = (): Declaration => JSON.parse(read('declaracion.json')) as Declaration;
export const portalExpected = (): ReturnType<typeof parseExpected> => parseExpected(JSON.parse(read('esperado.json')) as unknown);

export const observedField = (o: Partial<ObservedField> & Pick<ObservedField, 'field_id' | 'type' | 'label'>): ObservedField => ({
  help: '', required: true, value: '', ...o,
});
export const observedStep = (fields: ObservedField[], index = 1): ObservedStep => ({ index, total: 2, title: 'P', isSummary: false, fields, errors: [] });

/** Campos del portal de prueba (index.html) agrupados por paso. */
export function portalFieldsByStep(): Map<number, ObservedField[]> {
  const html = read('index.html');
  const re = /<label for="(p(\d)_f\d)">([^<]+)<\/label>\s*<(input|select)([^>]*)>([\s\S]*?)<small/g;
  const byStep = new Map<number, ObservedField[]>();
  for (const m of html.matchAll(re)) {
    const type = /data-type="(\w+)"/.exec(m[5]!)![1] as FieldType;
    const options = m[4] === 'select' ? [...m[6]!.matchAll(/<option value="([^"]+)">/g)].map((o) => o[1]!) : undefined;
    const list = byStep.get(Number(m[2])) ?? [];
    list.push(observedField({ field_id: m[1]!, type, label: m[3]!, required: /required/.test(m[5]!), ...(options ? { options } : {}) }));
    byStep.set(Number(m[2]), list);
  }
  return byStep;
}

/** Esperado de esperado.json y campos del portal por paso. */
export function portalExpectations(): { expected: ReturnType<typeof parseExpected>; byStep: Map<number, ObservedField[]> } {
  return { expected: portalExpected(), byStep: portalFieldsByStep() };
}
