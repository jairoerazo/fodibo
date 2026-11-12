import type {
  CaseInput,
  CaseSummary,
  CaseUpdate,
  CaseView,
  ConceptView,
  DocumentPatch,
  ExpedienteEvent,
  FieldHistoryEntry,
  FieldInput,
  ImportablePackage,
  ImportResult,
  ApprovalSummary,
} from '../core/expediente/index.js';

export type {
  ApprovalSummary,
  CaseInput,
  CaseSummary,
  CaseUpdate,
  CaseView,
  ConceptView,
  DocumentPatch,
  ExpedienteEvent,
  FieldHistoryEntry,
  FieldInput,
  ImportablePackage,
  ImportResult,
};

export const CASE_CHANNELS = {
  list: 'case:list',
  create: 'case:create',
  update: 'case:update',
  get: 'case:get',
  concepts: 'case:concepts',
  importable: 'case:importable',
  import: 'case:import',
  setDocument: 'case:set-document',
  saveField: 'case:save-field',
  deleteField: 'case:delete-field',
  fieldHistory: 'case:field-history',
  approve: 'case:approve',
  showDocument: 'case:show-document',
  event: 'case:event',
} as const;

/** Respuesta uniforme: los rechazos de `ipcRenderer.invoke` pierden el código, así que el error va en el valor. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface ExpedienteApi {
  listCases(): Promise<Result<CaseSummary[]>>;
  createCase(input: CaseInput): Promise<Result<CaseView>>;
  updateCase(caseId: string, input: CaseUpdate): Promise<Result<CaseView>>;
  getCase(caseId: string): Promise<Result<CaseView>>;
  listConcepts(): Promise<Result<ConceptView[]>>;
  listImportable(): Promise<Result<ImportablePackage[]>>;
  importPackage(caseId: string, packageId: string): Promise<Result<ImportResult>>;
  setDocument(documentId: string, patch: DocumentPatch): Promise<Result<CaseView>>;
  saveField(caseId: string, input: FieldInput): Promise<Result<CaseView>>;
  deleteField(fieldId: string): Promise<Result<CaseView>>;
  fieldHistory(fieldId: string): Promise<Result<FieldHistoryEntry[]>>;
  approve(caseId: string, expectedRevision: number): Promise<Result<ApprovalSummary>>;
  showDocumentInFolder(documentId: string): Promise<Result<void>>;
  /** Devuelve la función que cancela la suscripción. */
  onEvent(cb: (e: ExpedienteEvent) => void): () => void;
}
