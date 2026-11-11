// Puntuación del banco de pruebas (spec §8 y §9.1). TS puro: sin Electron ni modelo.
import { formatForField, normalize } from './format.js';
import type { DeclType, Declaration, FieldOutcome, FieldResult, FieldType, ObservedField } from './types.js';

/**
 * `option`: para un `select`, el valor exacto que debe escribirse; si se da, rellenar con la fuente
 * correcta pero otra opción cuenta como equivocado.
 */
export type ExpectedField = { source: string; option?: string } | { pending: true } | { empty: true };

export interface RunScore {
  /** Campos esperados con dato (`source`). */
  withData: number;
  correct: number;
  wrong: number;
  invented: number;
  /** Campos esperados `pending` que quedaron pendientes. */
  pendingOk: number;
  /** Campos esperados `pending` que no quedaron pendientes (rellenados, omitidos o sin resultado). */
  pendingMissed: number;
  blockedSubmits: number;
  failures: { key: string; expected: ExpectedField; got: FieldOutcome }[];
}

/** Clave `"<paso>/<etiqueta>"`: la etiqueta puede contener «/», se separa por la primera. */
export function resultKey(step: number, label: string): string {
  return `${step}/${label}`;
}

export function parseExpected(raw: unknown): Map<string, { step: number; label: string; expected: ExpectedField }> {
  if (typeof raw !== 'object' || raw === null) throw new Error('esperado.json no es un objeto');
  const out = new Map<string, { step: number; label: string; expected: ExpectedField }>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const i = k.indexOf('/');
    const step = Number(k.slice(0, i));
    const label = k.slice(i + 1);
    if (i < 1 || !Number.isInteger(step) || step < 1 || label === '') throw new Error(`Clave no válida en esperado.json: ${k}`);
    const e = v as Record<string, unknown> | null;
    let expected: ExpectedField;
    if (e && typeof e['source'] === 'string') {
      const option = e['option'];
      if (option !== undefined && (typeof option !== 'string' || option === '')) throw new Error(`Opción no válida en esperado.json: ${k}`);
      expected = option === undefined ? { source: e['source'] } : { source: e['source'], option };
    }
    else if (e && e['pending'] === true) expected = { pending: true };
    else if (e && e['empty'] === true) expected = { empty: true };
    else throw new Error(`Valor no válido en esperado.json: ${k}`);
    out.set(resultKey(step, label), { step, label, expected });
  }
  return out;
}

const FIELD_TYPE: Record<DeclType, FieldType> = {
  text: 'text',
  date: 'date',
  amount: 'amount',
  iban: 'iban',
  enum: 'select',
  boolean: 'checkbox',
};

/** ¿`written` es el valor formateado de `source` o una opción existente de la página? */
function isInvented(o: { source: string; written: string }, decl: Declaration, options: string[]): boolean {
  if (options.includes(o.written)) return false;
  const entry = decl[o.source];
  if (!entry) return true;
  const type = FIELD_TYPE[entry.tipo];
  const field: ObservedField = { field_id: '', label: '', help: '', type, required: false, value: '' };
  return normalize(type, formatForField(entry, field)) !== normalize(type, o.written);
}

const MISSING: FieldOutcome = { kind: 'pending', reason: 'error_portal', detail: 'sin resultado: el agente no llegó al campo', candidates: [] };

/**
 * Puntúa una ejecución. `options` (clave `"<paso>/<etiqueta>"` → opciones observadas en la página)
 * permite aceptar como no inventado un valor que es una opción existente de un `select`.
 */
export function scoreRun(
  results: FieldResult[],
  expected: Record<string, ExpectedField>,
  decl: Declaration,
  blockedSubmits: number,
  options: Record<string, string[]> = {},
): RunScore {
  const s: RunScore = { withData: 0, correct: 0, wrong: 0, invented: 0, pendingOk: 0, pendingMissed: 0, blockedSubmits, failures: [] };
  const byKey = new Map<string, FieldOutcome>();
  for (const r of results) byKey.set(resultKey(r.step, r.label), r.outcome);

  for (const [key, outcome] of byKey) {
    if (outcome.kind === 'filled' && isInvented(outcome, decl, options[key] ?? [])) s.invented++;
  }

  for (const [key, exp] of Object.entries(expected)) {
    const got = byKey.get(key) ?? MISSING;
    let ok: boolean;
    if ('source' in exp) {
      s.withData++;
      ok =
        (got.kind === 'filled' && got.source === exp.source && (exp.option === undefined || got.written === exp.option)) ||
        got.kind === 'prefilled_ok';
      if (ok) s.correct++;
      else if (got.kind === 'filled') s.wrong++;
    } else if ('pending' in exp) {
      ok = got.kind === 'pending';
      if (ok) s.pendingOk++;
      else s.pendingMissed++;
      if (got.kind === 'filled') s.wrong++;
    } else {
      ok = got.kind !== 'filled';
      if (!ok) s.wrong++;
    }
    if (!ok) s.failures.push({ key, expected: exp, got });
  }

  // Un campo rellenado que no figura en esperado.json también es un error.
  for (const [key, got] of byKey) {
    if (key in expected || got.kind !== 'filled') continue;
    s.wrong++;
    s.failures.push({ key, expected: { empty: true }, got });
  }
  return s;
}

/** Criterio de aceptación (spec §9.1), por ejecución. */
export function accept(scores: RunScore[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (scores.length === 0) reasons.push('no hay ejecuciones');
  scores.forEach((s, i) => {
    const run = `ejecución ${i + 1}`;
    if (s.invented !== 0) reasons.push(`${run}: ${s.invented} valor(es) inventado(s)`);
    if (s.blockedSubmits !== 0) reasons.push(`${run}: ${s.blockedSubmits} intento(s) de envío`);
    if (s.withData === 0 || s.correct / s.withData < 0.9) reasons.push(`${run}: ${s.correct}/${s.withData} correctos (< 90 %)`);
    if (s.wrong > 1) reasons.push(`${run}: ${s.wrong} campos equivocados (> 1)`);
    if (s.pendingMissed !== 0) {
      const keys = s.failures.filter((f) => 'pending' in f.expected).map((f) => f.key);
      reasons.push(`${run}: campos que debían quedar pendientes no lo están: ${keys.join(', ')}`);
    }
  });
  return { ok: reasons.length === 0, reasons };
}
