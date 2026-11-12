import { randomUUID } from 'node:crypto';
import { approvedDeclarationSchema } from '@fodibo/contracts';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Concept } from '../agent/index.js';
import { loadDeclaration } from '../agent/index.js';
import type { Declaration } from '../agent/types.js';
import { canonical } from '../common/canonical.js';
import { ExpedienteError } from './errors.js';
import { buildContent, contentHash, type ApprovalContent } from './projection.js';
import type { CaseView, ChangeEntry } from './service.js';
import { caseStatus } from './status.js';
import type { CaseStore } from './storage/index.js';
import { ACTOR_LOCAL, type ApprovalRow } from './types.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);
const validateSnapshot = ajv.compile(approvedDeclarationSchema);

export type ApprovalSummary = { approvalId: string; caseRevision: number; approvedAt: string; contentHash: string };
export type ApprovedDeclaration = ApprovalSummary & { declaration: Declaration };

/** Lo que el servicio entrega: la lectura del expediente ya con disponibilidad y la escritura de `changes` sin subir la revisión. */
export type ApprovalContext = {
  store: CaseStore;
  concepts: readonly Concept[];
  now: () => Date;
  /** Vista del expediente calculada dentro de la transacción en curso (documentos con `available`). */
  view: (caseId: string) => CaseView;
  /** Registra entradas en `changes` con la revisión actual (aprobar no la incrementa). */
  record: (caseId: string, revision: number, entries: ChangeEntry[]) => void;
};

const summary = (r: Pick<ApprovalRow, 'approval_id' | 'case_revision' | 'approved_at' | 'content_hash'>): ApprovalSummary => ({
  approvalId: r.approval_id,
  caseRevision: r.case_revision,
  approvedAt: r.approved_at,
  contentHash: r.content_hash,
});

const invalidProjection = (): ExpedienteError =>
  new ExpedienteError('storage_error', 'La proyección del expediente no es válida; no se ha guardado la aprobación.', { reason: 'invalid_projection' });

/** Aprobación (spec §8.1). Debe llamarse dentro de una transacción síncrona. */
export function approve(ctx: ApprovalContext, caseId: string, expectedRevision: number): ApprovalSummary {
  const row = ctx.store.getCase(caseId);
  if (!row) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
  if (expectedRevision !== row.revision) {
    throw new ExpedienteError('stale_revision', 'El expediente ha cambiado desde que lo viste.', { expected: expectedRevision, actual: row.revision });
  }
  const existing = ctx.store.getApprovalByRevision(caseId, row.revision);
  if (existing) return summary(existing);

  const view = ctx.view(caseId);
  const { blockers } = caseStatus(
    { revision: view.revision, persons: view.persons, documents: view.documents, fields: view.fields },
    ctx.concepts,
  );
  if (blockers.length > 0) throw new ExpedienteError('blocked', 'El expediente tiene bloqueos y no se puede aprobar.', { blockers });

  let content: ApprovalContent;
  try {
    content = buildContent(row, view.fields, view.documents, ctx.concepts);
    loadDeclaration(content.fields);
  } catch {
    // ProjectionError o rechazo de loadDeclaration: fallo interno, no se guarda nada.
    throw invalidProjection();
  }
  const approvalId = randomUUID();
  const approvedAt = ctx.now().toISOString();
  const hash = contentHash(content);
  const snapshot = {
    schema_version: 1,
    approval_id: approvalId,
    case_id: caseId,
    case_revision: row.revision,
    approved_at: approvedAt,
    approver: ACTOR_LOCAL,
    content_hash: hash,
    content,
  };
  if (!validateSnapshot(snapshot)) throw invalidProjection();

  const approval: ApprovalRow = {
    approval_id: approvalId,
    case_id: caseId,
    case_revision: row.revision,
    approved_at: approvedAt,
    approver: ACTOR_LOCAL,
    content_hash: hash,
    snapshot: canonical(snapshot),
  };
  ctx.store.insertApproval(approval);
  ctx.record(caseId, row.revision, [
    { entity: 'approval', entityId: approvalId, action: 'create', before: null, after: { case_revision: row.revision, content_hash: hash } },
  ]);
  return summary(approval);
}

const corrupt = (): ExpedienteError => new ExpedienteError('approval_corrupt', 'La aprobación guardada está dañada; hay que aprobar de nuevo.');

/**
 * Lectura para el agente (spec §8.3). Solo lee `approvals.snapshot`: no consulta las tablas vivas salvo la revisión actual.
 * Cualquier discrepancia (JSON, huella, contrato, `loadDeclaration`) es `approval_corrupt`.
 */
export function approvedDeclaration(store: CaseStore, caseId: string): ApprovedDeclaration {
  const current = store.getCase(caseId);
  if (!current) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
  const latest = store.getLatestApproval(caseId);
  if (!latest) throw new ExpedienteError('no_approval', 'El expediente no está aprobado.');
  if (latest.case_revision !== current.revision) {
    throw new ExpedienteError('approval_stale', 'El expediente ha cambiado desde la última aprobación.', { approved: latest.case_revision, current: current.revision });
  }

  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(latest.snapshot) as Record<string, unknown>;
  } catch {
    throw corrupt();
  }
  if (typeof snap !== 'object' || snap === null || typeof snap.content !== 'object' || snap.content === null) throw corrupt();
  const hash = contentHash(snap.content);
  if (hash !== latest.content_hash || hash !== snap.content_hash) throw corrupt();
  if (!validateSnapshot(snap)) throw corrupt();
  if (snap.approval_id !== latest.approval_id || snap.case_id !== caseId || snap.case_revision !== latest.case_revision) throw corrupt();
  let declaration: Declaration;
  try {
    declaration = loadDeclaration((snap.content as ApprovalContent).fields);
  } catch {
    throw corrupt();
  }
  return { declaration, ...summary(latest) };
}
