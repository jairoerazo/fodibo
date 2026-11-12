// Catálogo de conceptos fiscales suizos: asigna sin modelo los campos cuya etiqueta reconoce.
// La declaración usa como claves los ids de estos conceptos (terminología de los documentos suizos). Un
// concepto con `variants` agrupa claves `<id>_<variante>` (p. ej. la prima de cada persona): si la
// declaración trae más de una, el campo queda pendiente con todas como candidatas, en lugar de elegir.
// Las respuestas tienen la misma forma que las del modelo y pasan por `validateAnswer` como ellas.
import { typeCompatible } from './format.js';
import type { ModelAnswer } from './mapping.js';
import type { Declaration, DeclType, ObservedStep } from './types.js';

export interface Concept {
  /** Clave de la declaración; con `variants`, prefijo de las claves `<id>_<variante>`. */
  id: string;
  tipo: DeclType;
  /** Etiquetas del portal que designan exactamente este concepto. */
  labels: string[];
  variants?: boolean;
}

export const CONCEPTS: readonly Concept[] = [
  { id: 'nachname', tipo: 'text', labels: ['Name', 'Nachname', 'Familienname'] },
  { id: 'vorname', tipo: 'text', labels: ['Vorname', 'Vornamen'] },
  { id: 'geburtsdatum', tipo: 'date', labels: ['Geburtsdatum'] },
  { id: 'ahv_nr', tipo: 'text', labels: ['AHV-Nummer', 'AHV-Nr.', 'AHVN13'] },
  { id: 'zivilstand', tipo: 'enum', labels: ['Zivilstand'] },
  { id: 'arbeitgeber_name', tipo: 'text', labels: ['Arbeitgeber', 'Arbeitgeberin'] },
  { id: 'bruttolohn_jahr', tipo: 'amount', labels: ['Bruttolohn'] },
  { id: 'nettolohn_jahr', tipo: 'amount', labels: ['Nettolohn'] },
  { id: 'ahv_iv_eo_alv_abzuege', tipo: 'amount', labels: ['AHV/IV/EO-Beiträge', 'AHV/IV/EO/ALV-Beiträge'] },
  { id: 'pensionskasse_beitraege', tipo: 'amount', labels: ['Berufliche Vorsorge', 'BVG-Beiträge'] },
  { id: 'pendlerkosten_oev', tipo: 'amount', labels: ['Fahrkosten'] },
  { id: 'verpflegungsmehrkosten', tipo: 'amount', labels: ['Verpflegungsmehrkosten'] },
  { id: 'saeule_3a_einzahlung', tipo: 'amount', labels: ['Säule 3a'] },
  { id: 'krankenkasse_praemie', tipo: 'amount', labels: ['Krankenkassenprämien'], variants: true },
  { id: 'bankname', tipo: 'text', labels: ['Bank'] },
  { id: 'iban', tipo: 'iban', labels: ['IBAN'] },
  { id: 'iban_zweites_konto', tipo: 'iban', labels: ['Zweites Bankkonto'] },
  { id: 'kontosaldo_31_12', tipo: 'amount', labels: ['Saldo per 31.12.', 'Saldo am 31.12.'] },
  { id: 'zinsertrag', tipo: 'amount', labels: ['Zinsertrag'] },
];

const MAX_CANDIDATES = 5;

/** Forma comparable de una etiqueta: NFC, minúsculas, espacios simples, sin «:» ni «*» finales. */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s:*]+$/, '');
}

/**
 * Respuestas del catálogo para los campos del paso que reconoce (`resolved`); el resto queda para el
 * modelo. No resuelve un campo si su etiqueta es ambigua en el catálogo, si el tipo del campo no encaja
 * con el concepto, si en un select ninguna opción es igual al valor, o si dos campos del paso acabarían
 * con la misma clave.
 */
export function resolveFromCatalog(
  step: ObservedStep,
  decl: Declaration,
  concepts: readonly Concept[] = CONCEPTS,
): { answer: ModelAnswer; resolved: Set<string> } {
  const byLabel = new Map<string, Concept[]>();
  for (const c of concepts)
    for (const l of c.labels) {
      const k = normalizeLabel(l);
      byLabel.set(k, [...(byLabel.get(k) ?? []), c]);
    }
  const answer: ModelAnswer = {};
  const sources = new Map<string, string[]>();
  for (const field of step.fields) {
    const matches = byLabel.get(normalizeLabel(field.label)) ?? [];
    if (matches.length !== 1) continue;
    const c = matches[0]!;
    if (!typeCompatible(field.type, c.tipo)) continue;
    const keys = Object.keys(decl)
      .filter((k) => (k === c.id || (c.variants === true && k.startsWith(`${c.id}_`))) && decl[k]!.tipo === c.tipo)
      .sort();
    if (keys.length === 0) {
      answer[field.field_id] = field.required ? { pending: 'sin dato en la declaración', candidates: [] } : { skip: true };
    } else if (keys.length > 1) {
      answer[field.field_id] = { pending: 'varias variantes en la declaración', candidates: keys.slice(0, MAX_CANDIDATES) };
    } else {
      const key = keys[0]!;
      if (field.type === 'select') {
        const v = normalizeLabel(String(decl[key]!.valor));
        const option = (field.options ?? []).find((o) => normalizeLabel(o) === v);
        if (option === undefined) continue;
        answer[field.field_id] = { source: key, option };
      } else answer[field.field_id] = { source: key };
      sources.set(key, [...(sources.get(key) ?? []), field.field_id]);
    }
  }
  for (const ids of sources.values()) if (ids.length > 1) for (const id of ids) delete answer[id];
  return { answer, resolved: new Set(Object.keys(answer)) };
}
