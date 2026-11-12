import type { Concept } from '../agent/index.js';
import type { DeclType } from '../agent/types.js';
import { checkVocabulary } from './fields.js';
import type { DocStatus, Evidence, FieldStatus } from './types.js';

export type CaseStatus = 'incompleto' | 'revisable' | 'aprobado';
export type Blocker = {
  code: 'sin_campos' | 'documento_pendiente' | 'campo_pendiente' | 'concepto_desconocido' | 'evidencia_no_confirmada' | 'original_no_disponible';
  entity: 'case' | 'document' | 'field';
  id?: string;
};
export type Warning = { code: 'sin_evidencia'; fieldId: string };

export type StatusInput = {
  revision: number;
  persons: Array<{ slug: string }>;
  documents: Array<{ documentId: string; status: DocStatus; available: boolean }>;
  fields: Array<{ fieldId: string; conceptId: string; variant: string; tipo: DeclType; status: FieldStatus; evidence: Evidence[] }>;
  lastApproval?: { caseRevision: number };
};

/** ¿Cumple el campo el invariante 5 (concepto del catálogo, tipo del concepto, variante válida) con el catálogo actual? */
function knownConcept(concepts: readonly Concept[], slugs: string[], f: StatusInput['fields'][number]): boolean {
  try {
    return checkVocabulary(concepts, slugs, f.conceptId, f.variant).tipo === f.tipo;
  } catch {
    return false;
  }
}

/** Estado derivado del expediente (spec §7.2): función pura, sin columna que pueda desincronizarse. */
export function caseStatus(input: StatusInput, concepts: readonly Concept[]): { status: CaseStatus; blockers: Blocker[]; warnings: Warning[] } {
  const blockers: Blocker[] = [];
  const warnings: Warning[] = [];
  const slugs = input.persons.map((p) => p.slug);
  const docs = new Map(input.documents.map((d) => [d.documentId, d]));

  if (!input.fields.some((f) => f.status === 'confirmado')) blockers.push({ code: 'sin_campos', entity: 'case' });
  for (const d of input.documents) {
    if (d.status === 'pendiente_de_revision') blockers.push({ code: 'documento_pendiente', entity: 'document', id: d.documentId });
  }
  const unavailable = new Set<string>();
  for (const f of input.fields) {
    if (f.status === 'pendiente') blockers.push({ code: 'campo_pendiente', entity: 'field', id: f.fieldId });
    if (!knownConcept(concepts, slugs, f)) blockers.push({ code: 'concepto_desconocido', entity: 'field', id: f.fieldId });
    if (f.evidence.some((e) => docs.get(e.documentId)?.status !== 'confirmado')) {
      blockers.push({ code: 'evidencia_no_confirmada', entity: 'field', id: f.fieldId });
    }
    for (const e of f.evidence) if (docs.get(e.documentId)?.available === false) unavailable.add(e.documentId);
    if (f.status === 'confirmado' && f.evidence.length === 0) warnings.push({ code: 'sin_evidencia', fieldId: f.fieldId });
  }
  for (const id of unavailable) blockers.push({ code: 'original_no_disponible', entity: 'document', id });

  const status: CaseStatus = input.lastApproval?.caseRevision === input.revision ? 'aprobado' : blockers.length > 0 ? 'incompleto' : 'revisable';
  return { status, blockers, warnings };
}
