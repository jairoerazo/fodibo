import { createHash } from 'node:crypto';
import type { Concept } from '../agent/index.js';
import type { DeclEntry, Declaration } from '../agent/types.js';
import { canonical } from '../common/canonical.js';
import { splitKey } from './fields.js';
import type { DocumentView, FieldView } from './service.js';
import type { CaseRow, DocType } from './types.js';

/** Forma `content` de la instantánea aprobada (spec §8.2). */
export type ApprovalContent = {
  tax_year: number;
  jurisdiction: string;
  rules_version: null;
  fields: Declaration;
  evidence: Record<string, Array<{ document_id: string; sha256: string; page: number }>>;
  documents: Array<{ document_id: string; sha256: string; mime: string; doc_type: DocType }>;
};

/** Proyección interna inválida (fallo nuestro, no del usuario). */
export class ProjectionError extends Error {}

/**
 * Proyección del expediente: solo campos `confirmado` (invariante 8) y documentos `confirmado` ordenados por `sha256`.
 * No depende del orden de inserción: las claves de los objetos se ordenan al serializar y las listas se ordenan aquí.
 */
export function buildContent(
  caseRow: Pick<CaseRow, 'tax_year' | 'jurisdiction'>,
  fields: readonly FieldView[],
  documents: readonly DocumentView[],
  concepts: readonly Concept[],
): ApprovalContent {
  const sha = new Map(documents.map((d) => [d.documentId, d.sha256]));
  const out: ApprovalContent = { tax_year: caseRow.tax_year, jurisdiction: caseRow.jurisdiction, rules_version: null, fields: {}, evidence: {}, documents: [] };
  for (const f of fields) {
    if (f.status !== 'confirmado') continue;
    if (!splitKey(f.key, concepts)) throw new ProjectionError('Un campo no pertenece al catálogo.');
    if (Object.hasOwn(out.fields, f.key)) throw new ProjectionError('Clave de declaración repetida.');
    const entry: DeclEntry = f.tipo === 'amount' ? { tipo: f.tipo, valor: f.valor, moneda: f.moneda! } : { tipo: f.tipo, valor: f.valor };
    out.fields[f.key] = entry;
    out.evidence[f.key] = f.evidence.map((e) => {
      const s = sha.get(e.documentId);
      if (!s) throw new ProjectionError('Una evidencia cita un documento desconocido.');
      return { document_id: e.documentId, sha256: s, page: e.page };
    });
  }
  out.documents = documents
    .filter((d) => d.status === 'confirmado')
    .map((d) => ({ document_id: d.documentId, sha256: d.sha256, mime: d.mime, doc_type: d.docType! }))
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.document_id < b.document_id ? -1 : 1));
  return out;
}

/** SHA-256 hex de la serialización canónica de `content`. */
export function contentHash(content: unknown): string {
  return createHash('sha256').update(canonical(content), 'utf8').digest('hex');
}
