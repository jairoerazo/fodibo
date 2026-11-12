import { formatForField, normalize, typeCompatible } from './format.js';
import type { Declaration, ObservedField, ObservedStep, PendingReason } from './types.js';

export type ModelAnswer = Record<string, unknown>;

export type FieldPlan = { field: ObservedField } & (
  | { action: 'fill'; source: string; value: string }
  | { action: 'skip' }
  | { action: 'pending'; reason: PendingReason; detail?: string; candidates: { key: string; valor: string }[] }
  | { action: 'keep' }
);

const MAX_CANDIDATES = 5;
const MAX_DETAIL = 300;

/**
 * Esquema JSON de la respuesta del modelo para un paso (gramática de `llama-server`).
 * `source` y `candidates` solo admiten claves de la declaración de tipo compatible con el campo; la forma
 * `pending` va primero. Es una ayuda para el modelo: `validateAnswer` sigue siendo la puerta.
 */
export function responseSchema(step: ObservedStep, decl: Declaration): object {
  const properties: Record<string, object> = {};
  for (const f of step.fields) {
    const keys = Object.keys(decl).filter((k) => typeCompatible(f.type, decl[k]!.tipo));
    const forms: object[] = [];
    forms.push({
      type: 'object',
      properties: {
        // Breve: cada token generado cuesta tiempo en CPU.
        pending: { type: 'string', maxLength: 80 },
        candidates:
          keys.length > 0
            ? { type: 'array', items: { enum: keys }, maxItems: MAX_CANDIDATES }
            : { type: 'array', maxItems: 0 },
      },
      required: ['pending'],
      additionalProperties: false,
    });
    if (keys.length > 0) {
      if (f.type === 'select') {
        const options = f.options ?? [];
        if (options.length > 0) {
          forms.push({
            type: 'object',
            properties: { source: { enum: keys }, option: { enum: options } },
            required: ['source', 'option'],
            additionalProperties: false,
          });
        }
      } else {
        forms.push({
          type: 'object',
          properties: { source: { enum: keys } },
          required: ['source'],
          additionalProperties: false,
        });
      }
    }
    forms.push({
      type: 'object',
      properties: { skip: { const: true } },
      required: ['skip'],
      additionalProperties: false,
    });
    properties[f.field_id] = { oneOf: forms };
  }
  return {
    type: 'object',
    properties,
    required: step.fields.map((f) => f.field_id),
    additionalProperties: false,
  };
}

type Parsed =
  | { kind: 'source'; source: string; option?: string }
  | { kind: 'pending'; reason: string; candidates: string[] }
  | { kind: 'skip' };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

function parseValue(field: ObservedField, v: unknown): Parsed | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'skip') return v.skip === true ? { kind: 'skip' } : null;
  if (keys === 'source') return typeof v.source === 'string' ? { kind: 'source', source: v.source } : null;
  if (keys === 'option,source') {
    if (field.type !== 'select') return null;
    if (typeof v.source !== 'string' || typeof v.option !== 'string') return null;
    return { kind: 'source', source: v.source, option: v.option };
  }
  if (keys === 'pending' || keys === 'candidates,pending') {
    if (typeof v.pending !== 'string') return null;
    let candidates: string[] = [];
    if (v.candidates !== undefined) {
      if (!Array.isArray(v.candidates) || v.candidates.length > MAX_CANDIDATES) return null;
      if (!v.candidates.every((c) => typeof c === 'string')) return null;
      candidates = v.candidates as string[];
    }
    return { kind: 'pending', reason: v.pending, candidates };
  }
  return null;
}

const hasPrevious = (f: ObservedField): boolean =>
  f.value.trim() !== '' && !(f.type === 'checkbox' && f.value.trim() === 'false');

export function validateAnswer(
  step: ObservedStep,
  decl: Declaration,
  answer: unknown,
): { ok: true; plan: FieldPlan[] } | { ok: false; error: string } {
  if (!isObj(answer)) return { ok: false, error: 'La respuesta no es un objeto' };
  const ids = step.fields.map((f) => f.field_id);
  for (const id of ids) if (!has(answer, id)) return { ok: false, error: `Falta el campo ${id}` };
  for (const k of Object.keys(answer)) {
    if (!ids.includes(k)) return { ok: false, error: `Campo desconocido: ${k}` };
  }
  const parsed: Parsed[] = [];
  for (const f of step.fields) {
    const p = parseValue(f, answer[f.field_id]);
    if (!p) return { ok: false, error: `Forma no válida para ${f.field_id}` };
    parsed.push(p);
  }

  // Regla 7: misma clave usada por campos de tipos distintos.
  const typesByKey = new Map<string, Set<string>>();
  step.fields.forEach((f, i) => {
    const p = parsed[i]!;
    if (p.kind === 'source' && has(decl, p.source)) {
      const s = typesByKey.get(p.source) ?? new Set<string>();
      s.add(f.type);
      typesByKey.set(p.source, s);
    }
  });

  const pend = (
    field: ObservedField,
    reason: PendingReason,
    detail?: string,
    candidates: { key: string; valor: string }[] = [],
  ): FieldPlan => ({ field, action: 'pending', reason, ...(detail !== undefined ? { detail } : {}), candidates });

  const plan = step.fields.map((field, i): FieldPlan => {
    const p = parsed[i]!;
    const previous = hasPrevious(field);

    // Valor que se escribiría, solo si la respuesta es utilizable (reglas 4-7).
    let problem: FieldPlan | null = null;
    let source = '';
    let value = '';
    if (p.kind === 'source') {
      source = p.source;
      if (!has(decl, source)) {
        problem = pend(field, 'sin_dato', `clave inexistente: ${source.slice(0, 80)}`);
      } else {
        const entry = decl[source]!;
        if (!typeCompatible(field.type, entry.tipo)) {
          problem = pend(field, 'tipo_incompatible');
        } else if ((typesByKey.get(source)?.size ?? 0) > 1) {
          problem = pend(field, 'tipo_incompatible');
        } else if (field.type === 'select') {
          if (p.option === undefined || !(field.options ?? []).includes(p.option)) {
            problem = pend(field, 'tipo_incompatible');
          } else value = p.option;
        } else value = formatForField(entry, field);
      }
    }

    if (previous) {
      // Regla 2
      if (p.kind === 'source' && !problem && normalize(field.type, value) === normalize(field.type, field.value)) {
        return { field, action: 'keep' };
      }
      return pend(field, 'valor_previo_distinto');
    }
    if (p.kind === 'skip') return field.required ? pend(field, 'sin_dato') : { field, action: 'skip' };
    if (p.kind === 'pending') {
      const seen = new Set<string>();
      const candidates: { key: string; valor: string }[] = [];
      for (const key of p.candidates) {
        if (!has(decl, key) || seen.has(key)) continue;
        seen.add(key);
        candidates.push({ key, valor: String(decl[key]!.valor) });
      }
      const detail = p.reason.trim().slice(0, MAX_DETAIL);
      return pend(field, candidates.length >= 2 ? 'ambiguo' : 'sin_dato', detail || undefined, candidates);
    }
    if (problem) return problem;
    return { field, action: 'fill', source, value };
  });
  return { ok: true, plan };
}
