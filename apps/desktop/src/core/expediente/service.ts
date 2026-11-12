import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONCEPTS, type Concept } from '../agent/index.js';
import type { DeclType } from '../agent/types.js';
import { ExpedienteError } from './errors.js';
import {
  decodeValor,
  deleteField as deleteFieldTx,
  keyFor,
  proposeField as proposeFieldTx,
  saveField as saveFieldTx,
  setDocument as setDocumentTx,
  type DocumentPatch,
  type FieldInput,
  type FieldState,
  type FieldsContext,
  type ProposedFieldInput,
} from './fields.js';
import { importPackage, listImportable, recoverStore, type ImportContext, type ImportResult, type ImportablePackage, type RecoverResult } from './import.js';
import { approve as approveTx, approvedDeclaration as approvedDeclarationTx, type ApprovalSummary, type ApprovedDeclaration } from './approval.js';
import { caseStatus, type Blocker, type CaseStatus, type Warning } from './status.js';
import { BlobStore, openStore, type CaseStore } from './storage/index.js';
import {
  ACTOR_LOCAL,
  CANTONS,
  PERSON_ROLES,
  type Canton,
  type ChangeEntity,
  type DocStatus,
  type DocType,
  type DocumentRow,
  type Evidence,
  type FieldOrigin,
  type FieldRow,
  type FieldStatus,
  type PersonRole,
  type PersonRow,
} from './types.js';

export type CaseInput = { taxYear: number; jurisdiction: Canton; persons: Array<{ role: PersonRole; label: string }> };
export type CaseUpdate = {
  taxYear?: number;
  jurisdiction?: Canton;
  /** Lista deseada completa: sin `slug` es un alta; un `slug` que falta es una baja; otro `label` es un cambio de rótulo. */
  persons?: Array<{ slug?: string; role: PersonRole; label: string }>;
};
export type PersonView = { personId: string; role: PersonRole; ordinal: number; slug: string; label: string };
export type DocumentView = {
  documentId: string;
  sha256: string;
  mime: string;
  size: number;
  originalName: string;
  docType: DocType | null;
  status: DocStatus;
  sourceDevice: string;
  importedAt: string;
  /** Falso si el original falta en el almacén (según `recover()`) o falló una lectura posterior. */
  available: boolean;
};
export type FieldView = {
  fieldId: string;
  conceptId: string;
  variant: string;
  /** Clave de la declaración (`keyFor(conceptId, variant)`). */
  key: string;
  tipo: DeclType;
  valor: string | boolean;
  moneda: string | null;
  origin: FieldOrigin;
  status: FieldStatus;
  updatedAt: string;
  evidence: Evidence[];
};
export type CaseView = {
  caseId: string;
  taxYear: number;
  jurisdiction: Canton;
  revision: number;
  createdAt: string;
  persons: PersonView[];
  documents: DocumentView[];
  fields: FieldView[];
  status: CaseStatus;
  blockers: Blocker[];
  warnings: Warning[];
  lastApproval?: ApprovalSummary;
};
export type ConceptView = { id: string; tipo: DeclType; labels: string[]; variants: boolean; values?: string[] };
export type FieldHistoryEntry = {
  at: string;
  actor: string;
  action: 'create' | 'update' | 'delete';
  before: FieldState | null;
  after: FieldState | null;
  revision: number;
};
export type CaseSummary = {
  caseId: string;
  taxYear: number;
  jurisdiction: Canton;
  revision: number;
  createdAt: string;
  hauptpersonLabel: string | null;
};
export type ExpedienteEvent = { type: 'case-changed'; caseId: string; revision: number };
export type ExpedienteOpenOptions = {
  dataDir: string;
  inboxDir: string;
  now?: () => Date;
  concepts?: readonly Concept[];
  hooks?: { beforeImportCommit?: () => void };
};

/** Entrada del registro de cambios; `before`/`after` son objetos que se guardan como JSON (null en alta/baja). */
export type ChangeEntry = {
  entity: ChangeEntity;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
};

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_LABEL = 60;

const invalid = (message: string, field: string): ExpedienteError => new ExpedienteError('invalid_input', message, { field });

function checkYear(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_YEAR || v > MAX_YEAR) {
    throw invalid('El año fiscal debe ser un entero entre 2000 y 2100.', 'taxYear');
  }
  return v;
}
function checkJurisdiction(v: unknown): Canton {
  if (typeof v !== 'string' || !(CANTONS as readonly string[]).includes(v)) throw invalid('Cantón desconocido.', 'jurisdiction');
  return v as Canton;
}
function checkRole(v: unknown): PersonRole {
  if (typeof v !== 'string' || !(PERSON_ROLES as readonly string[]).includes(v)) throw invalid('Rol de persona desconocido.', 'role');
  return v as PersonRole;
}
function checkLabel(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > MAX_LABEL) {
    throw invalid('El rótulo de una persona debe tener entre 1 y 60 caracteres.', 'label');
  }
  return v;
}
function checkRoleCounts(roles: PersonRole[]): void {
  if (roles.filter((r) => r === 'hauptperson').length !== 1) throw invalid('El expediente necesita exactamente un titular.', 'persons');
  if (roles.filter((r) => r === 'partner').length > 1) throw invalid('El expediente admite como mucho una pareja.', 'persons');
}

const personView = (p: PersonRow): PersonView => ({ personId: p.person_id, role: p.role, ordinal: p.ordinal, slug: p.slug, label: p.label });
const json = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));
const documentView = (d: DocumentRow, available: boolean): DocumentView => ({
  documentId: d.document_id,
  sha256: d.sha256,
  mime: d.mime,
  size: d.size,
  originalName: d.original_name,
  docType: d.doc_type,
  status: d.status,
  sourceDevice: d.source_device,
  importedAt: d.imported_at,
  available,
});
const fieldView = (f: FieldRow, evidence: Evidence[]): FieldView => ({
  fieldId: f.field_id,
  conceptId: f.concept_id,
  variant: f.variant,
  key: keyFor(f.concept_id, f.variant),
  tipo: f.tipo,
  valor: decodeValor(f),
  moneda: f.moneda,
  origin: f.origin,
  status: f.status,
  updatedAt: f.updated_at,
  evidence,
});
const personJson = (p: PersonRow) => ({ role: p.role, ordinal: p.ordinal, slug: p.slug, label: p.label });

export class ExpedienteService {
  private listeners = new Set<(e: ExpedienteEvent) => void>();
  private pending: ExpedienteEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Documentos cuyo blob falta o tiene otro tamaño (última `recover()`) o cuya lectura falló después (`reportUnavailable`). */
  protected missing = new Set<string>();
  /** Originales cuya lectura falló después (p. ej. integrity_error): solo los limpia una restauración real del blob. */
  protected unreadable = new Set<string>();

  private constructor(
    protected readonly store: CaseStore,
    protected readonly blobs: BlobStore,
    readonly inboxDir: string,
    readonly now: () => Date,
    readonly concepts: readonly Concept[],
    readonly hooks: { beforeImportCommit?: () => void },
  ) {}

  static async open(opts: ExpedienteOpenOptions): Promise<ExpedienteService> {
    const now = opts.now ?? (() => new Date());
    const dir = join(opts.dataDir, 'expediente');
    const store = openStore({ dir, now });
    const svc = new ExpedienteService(store, new BlobStore(join(dir, 'blobs')), opts.inboxDir, now, opts.concepts ?? CONCEPTS, opts.hooks ?? {});
    try {
      await svc.recover();
    } catch (e) {
      store.close();
      throw e;
    }
    return svc;
  }

  private importContext(): ImportContext {
    return {
      store: this.store,
      blobs: this.blobs,
      inboxDir: this.inboxDir,
      now: this.now,
      hooks: this.hooks,
      transact: (fn) => this.transact(fn),
      commitChange: (caseId, entries) => this.commitChange(caseId, entries),
    };
  }

  /** Paquetes recibidos en `inbox/` con recibo y todavía sin importar, del más reciente al más antiguo. */
  listImportable(): Promise<ImportablePackage[]> {
    return listImportable(this.importContext());
  }

  /** Importa el paquete al expediente de forma idempotente (spec §9); las llamadas se serializan. */
  importPackage(caseId: string, packageId: string): Promise<ImportResult> {
    return this.enqueue(async () => {
      const written: string[] = [];
      const result = await importPackage({ ...this.importContext(), onBlobWritten: (sha) => written.push(sha) }, caseId, packageId);
      await this.refreshMissing(written);
      return result;
    });
  }

  /** Borra temporales y blobs huérfanos y anota los documentos sin su original (spec §9, recuperación). */
  recover(): Promise<RecoverResult> {
    return this.enqueue(async () => {
      const result = await recoverStore(this.importContext());
      this.missing = new Set(result.missing);
      return result;
    });
  }

  /**
   * Tras importar: quita de `missing` los documentos cuyo blob vuelve a estar con su tamaño y de `unreadable` los
   * cuyo blob ha publicado esta importación (`written`). Nunca falla: la importación ya está confirmada.
   */
  private async refreshMissing(written: string[]): Promise<void> {
    for (const id of [...this.unreadable]) {
      const doc = this.store.getDocument(id);
      if (!doc || written.includes(doc.sha256)) this.unreadable.delete(id);
    }
    for (const id of [...this.missing]) {
      try {
        const doc = this.store.getDocument(id);
        if (!doc) {
          this.missing.delete(id);
          continue;
        }
        const st = await this.blobs.stat(doc.sha256);
        if (st && st.size === doc.size) this.missing.delete(id);
      } catch {
        /* se conserva la marca */
      }
    }
  }

  /** Marca un original como no disponible tras una lectura fallida (lo llama el manejador del protocolo). */
  reportUnavailable(documentId: string): void {
    if (this.store.getDocument(documentId)) this.unreadable.add(documentId);
  }

  close(): void {
    this.listeners.clear();
    this.store.close();
  }

  on(cb: (e: ExpedienteEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Serializa las operaciones asíncronas; la cola sigue funcionando tras una operación rechazada. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Ejecuta `fn` en una transacción y, solo tras el COMMIT, emite los eventos que `commitChange` dejó pendientes.
   * Un listener que lance no afecta al servicio.
   */
  protected transact<T>(fn: () => T): T {
    this.pending = [];
    let result: T;
    try {
      result = this.store.transaction(fn);
    } catch (e) {
      this.pending = [];
      throw e;
    }
    const events = this.pending;
    this.pending = [];
    for (const ev of events) {
      for (const cb of [...this.listeners]) {
        try {
          cb(ev);
        } catch {
          /* un listener defectuoso no rompe el servicio */
        }
      }
    }
    return result;
  }

  /**
   * Regla de revisión: suma 1 a la revisión y registra cada entrada con esa revisión. Solo dentro de `transact`.
   * Todas las escrituras de contenido pasan por aquí.
   */
  protected commitChange(caseId: string, entries: ChangeEntry[]): number {
    const revision = this.store.incrementRevision(caseId);
    this.writeEntries(caseId, revision, entries);
    this.pending.push({ type: 'case-changed', caseId, revision });
    return revision;
  }

  private writeEntries(caseId: string, revision: number, entries: ChangeEntry[]): void {
    const at = this.now().toISOString();
    for (const e of entries) {
      this.store.insertChange({
        case_id: caseId,
        revision,
        at,
        actor: ACTOR_LOCAL,
        entity: e.entity,
        entity_id: e.entityId,
        action: e.action,
        before: json(e.before),
        after: json(e.after),
      });
    }
  }

  listCases(): CaseSummary[] {
    return this.store.listCaseSummaries().map((r) => ({
      caseId: r.case_id,
      taxYear: r.tax_year,
      jurisdiction: r.jurisdiction,
      revision: r.revision,
      createdAt: r.created_at,
      hauptpersonLabel: r.hauptperson_label,
    }));
  }

  getCase(caseId: string): CaseView {
    const row = this.store.getCase(caseId);
    if (!row) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
    const evidence = new Map<string, Evidence[]>();
    for (const e of this.store.listCaseEvidence(caseId)) {
      const list = evidence.get(e.field_id) ?? [];
      list.push({ documentId: e.document_id, page: e.page });
      evidence.set(e.field_id, list);
    }
    const persons = this.store.listPersons(caseId).map(personView);
    const documents = this.store.listDocuments(caseId).map((d) => documentView(d, !this.missing.has(d.document_id) && !this.unreadable.has(d.document_id)));
    const fields = this.store.listFields(caseId).map((f) => fieldView(f, evidence.get(f.field_id) ?? []));
    const approval = this.store.getLatestApprovalInfo(caseId);
    const lastApproval: ApprovalSummary | undefined = approval
      ? { approvalId: approval.approval_id, caseRevision: approval.case_revision, approvedAt: approval.approved_at, contentHash: approval.content_hash }
      : undefined;
    const { status, blockers, warnings } = caseStatus({ revision: row.revision, persons, documents, fields, lastApproval }, this.concepts);
    return {
      caseId: row.case_id,
      taxYear: row.tax_year,
      jurisdiction: row.jurisdiction,
      revision: row.revision,
      createdAt: row.created_at,
      persons,
      documents,
      fields,
      status,
      blockers,
      warnings,
      ...(lastApproval ? { lastApproval } : {}),
    };
  }

  /**
   * Aprueba exactamente la revisión que el usuario vio (spec §8.1). Síncrono: una única transacción.
   * Aprobar no sube la revisión; repetirlo sobre la misma revisión devuelve la aprobación existente.
   */
  approve(caseId: string, expectedRevision: number): ApprovalSummary {
    return this.transact(() =>
      approveTx(
        {
          store: this.store,
          concepts: this.concepts,
          now: this.now,
          view: (id) => this.getCase(id),
          record: (id, revision, entries) => this.writeEntries(id, revision, entries),
        },
        caseId,
        expectedRevision,
      ),
    );
  }

  /** Lo único que puede consumir el agente: la última aprobación vigente, leída solo de su instantánea (spec §8.3). */
  approvedDeclaration(caseId: string): ApprovedDeclaration {
    return approvedDeclarationTx(this.store, caseId);
  }

  private fieldsContext(): FieldsContext {
    return { store: this.store, concepts: this.concepts, now: this.now, commitChange: (caseId, entries) => this.commitChange(caseId, entries) };
  }

  /**
   * Cambia tipo y/o estado de un documento (spec §7.1). Síncrono: una única transacción, sin pasar por `enqueue`
   * (igual que `createCase`/`updateCase`); el llamador puede `await`ar el resultado igualmente.
   */
  setDocument(documentId: string, patch: DocumentPatch): CaseView {
    const caseId = this.transact(() => setDocumentTx(this.fieldsContext(), documentId, patch));
    return this.getCase(caseId);
  }

  /** Alta (sin `fieldId`) o corrección (con `fieldId`) de un campo por el usuario; queda `confirmado`. Síncrono. */
  saveField(caseId: string, input: FieldInput): CaseView {
    this.transact(() => saveFieldTx(this.fieldsContext(), caseId, input));
    return this.getCase(caseId);
  }

  /** Solo núcleo (sin IPC): alta de un campo `pendiente` propuesto por una regla o el modelo. Síncrono. */
  proposeField(caseId: string, input: ProposedFieldInput): CaseView {
    this.transact(() => proposeFieldTx(this.fieldsContext(), caseId, input));
    return this.getCase(caseId);
  }

  /** Borra el campo; su historial se conserva. Síncrono. */
  deleteField(fieldId: string): CaseView {
    const caseId = this.transact(() => deleteFieldTx(this.fieldsContext(), fieldId));
    return this.getCase(caseId);
  }

  listConcepts(): ConceptView[] {
    return this.concepts.map((c) => ({ id: c.id, tipo: c.tipo, labels: [...c.labels], variants: c.variants === true, ...(c.values ? { values: [...c.values] } : {}) }));
  }

  /** Historial de un campo (también borrado) en orden cronológico. */
  fieldHistory(fieldId: string): FieldHistoryEntry[] {
    return this.store.listFieldChanges(fieldId).map((c) => ({
      at: c.at,
      actor: c.actor,
      action: c.action as FieldHistoryEntry['action'],
      before: c.before === null ? null : (JSON.parse(c.before) as FieldState),
      after: c.after === null ? null : (JSON.parse(c.after) as FieldState),
      revision: c.revision,
    }));
  }

  createCase(input: CaseInput): CaseView {
    const taxYear = checkYear(input?.taxYear);
    const jurisdiction = checkJurisdiction(input?.jurisdiction);
    if (!Array.isArray(input.persons)) throw invalid('Faltan las personas del expediente.', 'persons');
    const wanted = input.persons.map((p) => ({ role: checkRole(p?.role), label: checkLabel(p?.label) }));
    checkRoleCounts(wanted.map((p) => p.role));

    const caseId = randomUUID();
    this.transact(() => {
      this.store.insertCase({
        case_id: caseId,
        tax_year: taxYear,
        jurisdiction,
        rules_version: null,
        revision: 0,
        created_at: this.now().toISOString(),
      });
      const entries: ChangeEntry[] = [
        { entity: 'case', entityId: caseId, action: 'create', before: null, after: { tax_year: taxYear, jurisdiction } },
      ];
      let kinds = 0;
      for (const p of wanted) {
        const ordinal = p.role === 'kind' ? ++kinds : 1;
        const row: PersonRow = {
          person_id: randomUUID(),
          case_id: caseId,
          role: p.role,
          ordinal,
          slug: p.role === 'kind' ? `kind_${ordinal}` : p.role,
          label: p.label,
        };
        this.store.insertPerson(row);
        entries.push({ entity: 'person', entityId: row.person_id, action: 'create', before: null, after: personJson(row) });
      }
      // La creación deja revision = 0: no es un cambio de revisión, así que no pasa por commitChange ni emite evento.
      this.writeEntries(caseId, 0, entries);
    });
    return this.getCase(caseId);
  }

  updateCase(caseId: string, input: CaseUpdate): CaseView {
    const taxYear = input?.taxYear === undefined ? undefined : checkYear(input.taxYear);
    const jurisdiction = input?.jurisdiction === undefined ? undefined : checkJurisdiction(input.jurisdiction);
    if (input?.persons !== undefined && !Array.isArray(input.persons)) throw invalid('Lista de personas no válida.', 'persons');
    const desired = input?.persons?.map((p) => ({
      slug: p?.slug,
      role: checkRole(p?.role),
      label: checkLabel(p?.label),
    }));
    if (desired?.some((p) => p.slug !== undefined && typeof p.slug !== 'string')) throw invalid('Identificador de persona no válido.', 'slug');

    this.transact(() => {
      const current = this.store.getCase(caseId);
      if (!current) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
      const entries: ChangeEntry[] = [];

      const nextYear = taxYear ?? current.tax_year;
      const nextJurisdiction = jurisdiction ?? current.jurisdiction;
      if (nextYear !== current.tax_year || nextJurisdiction !== current.jurisdiction) {
        entries.push({
          entity: 'case',
          entityId: caseId,
          action: 'update',
          before: { tax_year: current.tax_year, jurisdiction: current.jurisdiction },
          after: { tax_year: nextYear, jurisdiction: nextJurisdiction },
        });
      }

      const removes: PersonRow[] = [];
      const relabels: Array<{ row: PersonRow; label: string }> = [];
      const adds: Array<{ role: PersonRole; label: string }> = [];
      if (desired) {
        const existing = new Map(this.store.listPersons(caseId).map((p) => [p.slug, p]));
        const seen = new Set<string>();
        for (const d of desired) {
          if (d.slug === undefined) {
            adds.push(d);
            continue;
          }
          const row = existing.get(d.slug);
          if (!row || seen.has(d.slug)) throw invalid('Persona desconocida o repetida en la lista.', 'slug');
          if (row.role !== d.role) throw invalid('No se puede cambiar el rol de una persona.', 'role');
          seen.add(d.slug);
          if (row.label !== d.label) relabels.push({ row, label: d.label });
        }
        for (const row of existing.values()) if (!seen.has(row.slug)) removes.push(row);
        checkRoleCounts(desired.map((d) => d.role));

        for (const row of removes) {
          const fieldIds = this.store.fieldIdsWithVariant(caseId, row.slug);
          if (fieldIds.length > 0) {
            throw new ExpedienteError('person_in_use', 'La persona tiene campos asociados y no se puede dar de baja.', { fieldIds });
          }
        }
        for (const row of removes) {
          this.store.deletePerson(row.person_id);
          entries.push({ entity: 'person', entityId: row.person_id, action: 'delete', before: personJson(row), after: null });
        }
        for (const { row, label } of relabels) {
          this.store.updatePersonLabel(row.person_id, label);
          entries.push({
            entity: 'person',
            entityId: row.person_id,
            action: 'update',
            before: personJson(row),
            after: personJson({ ...row, label }),
          });
        }
        let kinds = this.store.maxKindOrdinal(caseId);
        for (const a of adds) {
          const ordinal = a.role === 'kind' ? ++kinds : 1;
          const row: PersonRow = {
            person_id: randomUUID(),
            case_id: caseId,
            role: a.role,
            ordinal,
            slug: a.role === 'kind' ? `kind_${ordinal}` : a.role,
            label: a.label,
          };
          this.store.insertPerson(row);
          entries.push({ entity: 'person', entityId: row.person_id, action: 'create', before: null, after: personJson(row) });
        }
      }

      if (entries.length === 0) return;
      if (nextYear !== current.tax_year || nextJurisdiction !== current.jurisdiction) {
        this.store.updateCaseHeader(caseId, nextYear, nextJurisdiction);
      }
      this.commitChange(caseId, entries);
    });
    return this.getCase(caseId);
  }
}
