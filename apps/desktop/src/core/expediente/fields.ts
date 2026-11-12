import { randomUUID } from 'node:crypto';
import type { Concept } from '../agent/index.js';
import type { DeclEntry } from '../agent/types.js';
import { ExpedienteError } from './errors.js';
import type { ChangeEntry } from './service.js';
import type { CaseStore } from './storage/index.js';
import { DOC_TYPES, type DocStatus, type DocType, type DocumentRow, type Evidence, type FieldOrigin, type FieldRow, type FieldStatus } from './types.js';
import { normalizeValue } from './validation.js';

/** Variante que designa al hogar en conjunto (spec §6.2). */
export const FAMILIE = 'familie';
export const MAX_EVIDENCE = 20;
export const MAX_PAGE = 9999;

export type FieldInput = { fieldId?: string; conceptId: string; variant: string; valor: string | boolean; moneda?: string; evidence: Evidence[] };
export type ProposedFieldInput = FieldInput & { origin: 'regla' | 'modelo' };
export type DocumentPatch = { docType?: DocType; status?: 'pendiente_de_revision' | 'confirmado' | 'descartado' };

/** Forma guardada en `changes.before/after` (spec §5.2, invariante 4). */
export type FieldState = { tipo: string; valor: string | boolean; moneda: string | null; origin: FieldOrigin; status: FieldStatus; evidence: Evidence[] };

/** Lo que el servicio entrega: las escrituras de contenido siguen pasando por su `transact`/`commitChange`. */
export type FieldsContext = {
  store: CaseStore;
  concepts: readonly Concept[];
  now: () => Date;
  commitChange: (caseId: string, entries: ChangeEntry[]) => number;
};

const invalid = (message: string, field: string): ExpedienteError => new ExpedienteError('invalid_input', message, { field });
const VARIANT_RE = /^(?:hauptperson|partner|kind_[1-9]\d*|familie)$/;

/** Clave de la declaración: `conceptId` si no hay variante y `<conceptId>_<variante>` en otro caso (spec §6.2). */
export function keyFor(conceptId: string, variant: string): string {
  return variant === '' ? conceptId : `${conceptId}_${variant}`;
}

/** Inversa de `keyFor`; `undefined` si la clave no corresponde a ningún concepto del catálogo. */
export function splitKey(key: string, concepts: readonly Concept[]): { conceptId: string; variant: string } | undefined {
  const exact = concepts.find((c) => c.id === key);
  if (exact) return { conceptId: exact.id, variant: '' };
  // Con prefijos solapados gana el concepto de id más largo.
  let best: { conceptId: string; variant: string } | undefined;
  for (const c of concepts) {
    if (!c.variants || !key.startsWith(`${c.id}_`)) continue;
    const variant = key.slice(c.id.length + 1);
    if (VARIANT_RE.test(variant) && (!best || c.id.length > best.conceptId.length)) best = { conceptId: c.id, variant };
  }
  return best;
}

/** Comprueba la combinación concepto/variante (invariante 5) y devuelve el concepto. */
export function checkVocabulary(concepts: readonly Concept[], personSlugs: string[], conceptId: unknown, variant: unknown): Concept {
  if (typeof conceptId !== 'string') throw invalid('Concepto no válido.', 'conceptId');
  if (typeof variant !== 'string') throw invalid('Variante no válida.', 'variant');
  const concept = concepts.find((c) => c.id === conceptId);
  if (!concept) throw invalid('El concepto no existe en el catálogo.', 'conceptId');
  if (!concept.variants) {
    if (variant !== '') throw invalid('Este concepto no admite variante.', 'variant');
  } else if (variant !== FAMILIE && !personSlugs.includes(variant)) {
    throw invalid('Este concepto exige una variante: una persona del expediente o «familie».', 'variant');
  }
  return concept;
}

const byKey = (a: Evidence, b: Evidence): number => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : a.page - b.page);

/**
 * Valida las evidencias (spec §6.4): hasta 20, sin duplicados, de documentos del mismo expediente no descartados;
 * página 0–9999 y, si el documento no es PDF, 0. Devuelve una copia ordenada por documento y página.
 */
export function checkEvidence(store: CaseStore, caseId: string, evidence: unknown): Evidence[] {
  if (!Array.isArray(evidence)) throw invalid('Las evidencias no son una lista.', 'evidence');
  if (evidence.length > MAX_EVIDENCE) throw invalid(`Un campo admite como mucho ${MAX_EVIDENCE} evidencias.`, 'evidence');
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const e of evidence as Array<Partial<Evidence> | null>) {
    if (!e || typeof e.documentId !== 'string' || typeof e.page !== 'number' || !Number.isInteger(e.page)) {
      throw invalid('Evidencia no válida.', 'evidence');
    }
    const doc = store.getDocument(e.documentId);
    if (!doc || doc.case_id !== caseId) throw invalid('La evidencia cita un documento que no es de este expediente.', 'evidence');
    if (doc.status === 'descartado') throw invalid('La evidencia cita un documento descartado.', 'evidence');
    const maxPage = doc.mime === 'application/pdf' ? MAX_PAGE : 0;
    if (e.page < 0 || e.page > maxPage) throw invalid('Página de la evidencia fuera de rango.', 'evidence');
    const k = `${e.documentId}#${e.page}`;
    if (seen.has(k)) throw invalid('Evidencia repetida.', 'evidence');
    seen.add(k);
    out.push({ documentId: e.documentId, page: e.page });
  }
  return out.sort(byKey);
}

/** Valor guardado (texto) → valor de la declaración. */
export const decodeValor = (row: Pick<FieldRow, 'tipo' | 'valor'>): string | boolean => (row.tipo === 'boolean' ? row.valor === 'true' : row.valor);

export function fieldState(row: FieldRow, evidence: Evidence[]): FieldState {
  return { tipo: row.tipo, valor: decodeValor(row), moneda: row.moneda, origin: row.origin, status: row.status, evidence };
}

const toEvidence = (store: CaseStore, fieldId: string): Evidence[] =>
  store.listEvidence(fieldId).map((e) => ({ documentId: e.document_id, page: e.page }));

function replaceEvidence(store: CaseStore, fieldId: string, evidence: Evidence[]): void {
  store.deleteEvidence(fieldId);
  for (const e of evidence) store.insertEvidence({ field_id: fieldId, document_id: e.documentId, page: e.page });
}

function requireCase(store: CaseStore, caseId: string): void {
  if (!store.getCase(caseId)) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
}

type Parsed = { entry: DeclEntry; evidence: Evidence[] };

/** Valida concepto/variante, valor y evidencias de una entrada; debe llamarse dentro de la transacción. */
function parseInput(ctx: FieldsContext, caseId: string, input: FieldInput): Parsed {
  if (!input || typeof input !== 'object') throw invalid('Datos del campo no válidos.', 'input');
  const slugs = ctx.store.listPersons(caseId).map((p) => p.slug);
  const concept = checkVocabulary(ctx.concepts, slugs, input.conceptId, input.variant);
  const entry = normalizeValue(concept, { valor: input.valor, moneda: input.moneda });
  return { entry, evidence: checkEvidence(ctx.store, caseId, input.evidence) };
}

const sameEvidence = (a: Evidence[], b: Evidence[]): boolean => a.length === b.length && a.every((e, i) => e.documentId === b[i]!.documentId && e.page === b[i]!.page);

function fieldRow(ctx: FieldsContext, base: Pick<FieldRow, 'field_id' | 'case_id' | 'concept_id' | 'variant'>, entry: DeclEntry, origin: FieldOrigin, status: FieldStatus): FieldRow {
  return {
    ...base,
    tipo: entry.tipo,
    valor: String(entry.valor),
    moneda: entry.moneda ?? null,
    origin,
    status,
    updated_at: ctx.now().toISOString(),
  };
}

function create(ctx: FieldsContext, caseId: string, input: FieldInput, origin: FieldOrigin, status: FieldStatus): void {
  const { entry, evidence } = parseInput(ctx, caseId, input);
  if (ctx.store.getFieldByKey(caseId, input.conceptId, input.variant)) {
    throw invalid('Ya existe un campo para ese concepto y variante; corrígelo en lugar de crear otro.', 'conceptId');
  }
  const row = fieldRow(ctx, { field_id: randomUUID(), case_id: caseId, concept_id: input.conceptId, variant: input.variant }, entry, origin, status);
  ctx.store.insertField(row);
  replaceEvidence(ctx.store, row.field_id, evidence);
  ctx.commitChange(caseId, [{ entity: 'field', entityId: row.field_id, action: 'create', before: null, after: fieldState(row, evidence) }]);
}

/** Alta (sin `fieldId`) o corrección (con `fieldId`) por el usuario; el resultado queda `confirmado`. */
export function saveField(ctx: FieldsContext, caseId: string, input: FieldInput): void {
  requireCase(ctx.store, caseId);
  if (input?.fieldId === undefined) return create(ctx, caseId, input, 'usuario', 'confirmado');
  if (typeof input.fieldId !== 'string') throw invalid('Identificador de campo no válido.', 'fieldId');
  const current = ctx.store.getField(input.fieldId);
  if (!current || current.case_id !== caseId) throw new ExpedienteError('not_found', 'Campo no encontrado.');
  if (input.conceptId !== current.concept_id || input.variant !== current.variant) {
    throw invalid('Un campo no puede cambiar de concepto ni de variante.', 'conceptId');
  }
  const { entry, evidence } = parseInput(ctx, caseId, input);
  const beforeEvidence = toEvidence(ctx.store, current.field_id);
  // Invariante 8 (Ruling 11): el origen se conserva mientras valor y moneda normalizados no cambien (sea cual sea el estado
  // previo y aunque cambien las evidencias); solo cambiar el valor o la moneda lo pasa a usuario.
  const unchanged = String(entry.valor) === current.valor && (entry.moneda ?? null) === current.moneda;
  const origin: FieldOrigin = unchanged ? current.origin : 'usuario';
  const next = fieldRow(ctx, current, entry, origin, 'confirmado');
  const before = fieldState(current, beforeEvidence);
  const after = fieldState(next, evidence);
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  ctx.store.updateField(next);
  replaceEvidence(ctx.store, current.field_id, evidence);
  ctx.commitChange(caseId, [{ entity: 'field', entityId: current.field_id, action: 'update', before, after }]);
}

/** Alta de un campo `pendiente` propuesto por una regla o por el modelo (solo núcleo). */
export function proposeField(ctx: FieldsContext, caseId: string, input: ProposedFieldInput): void {
  requireCase(ctx.store, caseId);
  if (!input || !PROPOSAL_ORIGINS.includes(input.origin)) {
    throw invalid('El origen de una propuesta debe ser «regla» o «modelo».', 'origin');
  }
  if (input.fieldId !== undefined) throw invalid('Una propuesta no puede indicar un campo existente.', 'fieldId');
  create(ctx, caseId, input, input.origin, 'pendiente');
}

/** Borra el campo (y sus evidencias); el historial en `changes` se conserva. Devuelve el expediente afectado. */
export function deleteField(ctx: FieldsContext, fieldId: string): string {
  const row = typeof fieldId === 'string' ? ctx.store.getField(fieldId) : undefined;
  if (!row) throw new ExpedienteError('not_found', 'Campo no encontrado.');
  const before = fieldState(row, toEvidence(ctx.store, fieldId));
  ctx.store.deleteField(fieldId);
  ctx.commitChange(row.case_id, [{ entity: 'field', entityId: fieldId, action: 'delete', before, after: null }]);
  return row.case_id;
}

const PROPOSAL_ORIGINS: readonly string[] = ['regla', 'modelo'];
const DOC_PATCH_STATUSES: readonly string[] = ['pendiente_de_revision', 'confirmado', 'descartado'];

/** ¿Está la transición de estado de documento permitida por la spec §7.1? */
function allowedTransition(from: DocStatus, to: DocStatus): boolean {
  if (to === 'descartado') return true;
  if (from === 'pendiente_de_revision') return to === 'confirmado';
  if (from === 'confirmado') return to === 'pendiente_de_revision';
  if (from === 'descartado') return to === 'pendiente_de_revision';
  return false;
}

/** Cambia tipo y/o estado de un documento (spec §7.1). Devuelve el expediente afectado. */
export function setDocument(ctx: FieldsContext, documentId: string, patch: DocumentPatch): string {
  const doc: DocumentRow | undefined = typeof documentId === 'string' ? ctx.store.getDocument(documentId) : undefined;
  if (!doc) throw new ExpedienteError('not_found', 'Documento no encontrado.');
  if (!patch || typeof patch !== 'object') throw invalid('Cambio de documento no válido.', 'patch');
  if (patch.docType !== undefined && !(DOC_TYPES as readonly string[]).includes(patch.docType)) throw invalid('Tipo de documento desconocido.', 'docType');
  if (patch.status !== undefined && !DOC_PATCH_STATUSES.includes(patch.status)) throw invalid('Estado de documento no válido.', 'status');

  const docType = patch.docType ?? doc.doc_type;
  const status = patch.status ?? doc.status;
  if (docType === doc.doc_type && status === doc.status) return doc.case_id;

  if (status !== doc.status) {
    if (!allowedTransition(doc.status, status)) {
      throw new ExpedienteError('invalid_transition', 'Transición de estado de documento no permitida.', { from: doc.status, to: status });
    }
    if (status === 'confirmado' && docType === null) {
      throw new ExpedienteError('invalid_transition', 'Un documento necesita tipo para confirmarse.', { from: doc.status, to: status });
    }
    if (status === 'descartado') {
      const fieldIds = ctx.store.fieldIdsCitingDocument(documentId);
      if (fieldIds.length > 0) throw new ExpedienteError('invalid_transition', 'Hay campos que citan este documento.', { fieldIds });
    }
  }
  ctx.store.updateDocument(documentId, docType, status);
  ctx.commitChange(doc.case_id, [
    {
      entity: 'document',
      entityId: documentId,
      action: 'update',
      before: { doc_type: doc.doc_type, status: doc.status },
      after: { doc_type: docType, status },
    },
  ]);
  return doc.case_id;
}
