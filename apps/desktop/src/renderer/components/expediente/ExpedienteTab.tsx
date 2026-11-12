import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseInput, CaseSummary, CaseView, ConceptView, DocumentPatch, FieldInput, ImportablePackage, Result } from '../../../shared/expediente-ipc.js';
import { ApproveDialog } from './ApproveDialog.js';
import { CaseHeader } from './CaseHeader.js';
import { DocumentList } from './DocumentList.js';
import { FieldForm } from './FieldForm.js';
import { FieldList } from './FieldList.js';
import { BLOCKER_LABEL, WARNING_LABEL } from './labels.js';
import { NewCaseForm } from './NewCaseForm.js';

type Field = CaseView['fields'][number];
type Doc = CaseView['documents'][number];
type FormState = { mode: 'add' } | { mode: 'edit'; field: Field };
const CANCELLED: Result<never> = { ok: false, error: { code: 'cancelled', message: '' } };

export function ExpedienteTab({
  caseId,
  onSelectCase,
  selectedDocumentId,
  onSelectDocument,
  refreshKey = 0,
}: {
  caseId: string | undefined;
  onSelectCase: (caseId: string | undefined) => void;
  selectedDocumentId: string | undefined;
  onSelectDocument: (documentId: string | undefined) => void;
  /** Súbelo para recargar (p. ej. tras importar desde la pestaña de paquetes recibidos). */
  refreshKey?: number;
}) {
  const [cases, setCases] = useState<CaseSummary[]>();
  const [concepts, setConcepts] = useState<ConceptView[]>([]);
  const [importable, setImportable] = useState<ImportablePackage[]>([]);
  const [view, setView] = useState<CaseView>();
  const [error, setError] = useState<string>();
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState<FormState>();
  const [page, setPage] = useState(1);
  const [approve, setApprove] = useState<{ error?: string; busy: boolean }>();
  const [annul, setAnnul] = useState<{ resolve: (ok: boolean) => void }>();
  const viewRef = useRef<CaseView | undefined>(undefined);
  viewRef.current = view;
  const caseIdRef = useRef(caseId);
  caseIdRef.current = caseId;
  const api = () => window.fodiboExpediente;

  const loadCases = useCallback(async () => {
    const r = await api().listCases();
    if (r.ok) setCases(r.value);
    else {
      setCases((prev) => prev ?? []);
      setError(r.error.message);
    }
    return r.ok ? r.value : undefined;
  }, []);
  const loadImportable = useCallback(async () => {
    const r = await api().listImportable();
    if (r.ok) setImportable(r.value);
    else setError(r.error.message);
  }, []);
  const loadView = useCallback(async (id: string) => {
    const r = await api().getCase(id);
    if (id !== caseIdRef.current) return;
    if (r.ok) setView(r.value);
    else setError(r.error.message);
  }, []);

  useEffect(() => {
    void loadCases();
    void loadImportable();
    void api().listConcepts().then((r) => (r.ok ? setConcepts(r.value) : setError(r.error.message)));
  }, [loadCases, loadImportable]);

  // Un expediente recordado que ya no existe se descarta en silencio.
  useEffect(() => {
    setView(undefined);
    setForm(undefined);
    setApprove(undefined);
    if (!caseId || !cases) return;
    if (!cases.some((c) => c.caseId === caseId)) onSelectCase(undefined);
    else void loadView(caseId);
    // `cases` entra solo para saber si ya se cargó; recargar la lista no debe recargar la vista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, cases === undefined, refreshKey]);

  useEffect(() => {
    if (refreshKey === 0) return;
    void loadCases();
    void loadImportable();
  }, [refreshKey, loadCases, loadImportable]);

  useEffect(
    () =>
      api().onEvent((e) => {
        void loadCases();
        if (e.caseId === caseIdRef.current && e.revision !== viewRef.current?.revision) void loadView(e.caseId);
      }),
    [loadCases, loadView],
  );

  /** Un expediente aprobado avisa antes del primer cambio: editarlo anula la aprobación (spec §10.1). */
  const guard = (): Promise<boolean> =>
    viewRef.current?.status === 'aprobado' ? new Promise<boolean>((resolve) => setAnnul({ resolve })) : Promise.resolve(true);

  const mutate = async (call: () => Promise<Result<CaseView>>, quiet = false): Promise<Result<CaseView>> => {
    if (!(await guard())) return CANCELLED;
    const r = await call();
    if (r.ok) {
      setView(r.value);
      setError(undefined);
    } else if (!quiet) setError(r.error.message);
    return r;
  };

  const createCase = async (input: CaseInput): Promise<Result<CaseView>> => {
    const r = await api().createCase(input);
    if (r.ok) {
      await loadCases();
      setView(r.value);
      setShowNew(false);
      setError(undefined);
      onSelectCase(r.value.caseId);
    }
    return r;
  };

  const patchDocument = (d: Doc, patch: DocumentPatch) => {
    if (patch.status === 'descartado' && view) {
      const citing = view.fields.filter((f) => f.evidence.some((e) => e.documentId === d.documentId)).map((f) => f.key);
      if (citing.length > 0) {
        setError(`No se puede descartar «${d.originalName}»: lo citan los campos ${citing.join(', ')}.`);
        return;
      }
    }
    void mutate(() => api().setDocument(d.documentId, patch));
  };

  const importPackage = async (pkg: ImportablePackage) => {
    if (!caseId || !(await guard())) return;
    const r = await api().importPackage(caseId, pkg.packageId);
    if (!r.ok) return setError(r.error.message);
    setError(undefined);
    await Promise.all([loadView(caseId), loadImportable()]);
  };

  const saveField = (input: FieldInput) =>
    mutate(() => api().saveField(caseId!, input), true).then((r) => {
      if (r.ok) setForm(undefined);
      return r;
    });

  const confirmApprove = async () => {
    if (!view || !caseId) return;
    setApprove({ busy: true });
    const r = await api().approve(caseId, view.revision);
    // approve no emite case-changed (no sube la revisión): se refresca a mano.
    await loadView(caseId);
    if (r.ok) setApprove(undefined);
    else setApprove({ busy: false, error: r.error.message });
  };

  const selectEvidence = (documentId: string, p: number) => {
    onSelectDocument(documentId);
    setPage(p);
  };
  const selectedDoc = view?.documents.find((d) => d.documentId === selectedDocumentId);
  const defaultEvidence = selectedDoc && selectedDoc.status !== 'descartado' ? { documentId: selectedDoc.documentId, page } : undefined;
  const entityName = (b: CaseView['blockers'][number]) =>
    b.entity === 'document' ? view?.documents.find((d) => d.documentId === b.id)?.originalName : b.entity === 'field' ? view?.fields.find((f) => f.fieldId === b.id)?.key : undefined;

  return (
    <div className="expediente">
      <CaseHeader
        cases={cases ?? []}
        caseId={caseId}
        view={view}
        onSelectCase={onSelectCase}
        onNew={() => setShowNew(true)}
        onApprove={() => setApprove({ busy: false })}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {showNew && <NewCaseForm onCreate={createCase} onCancel={() => setShowNew(false)} />}
      {!caseId && !showNew && cases && <p className="empty">Selecciona un expediente o crea uno nuevo.</p>}
      {view && (
        <>
          {(view.blockers.length > 0 || view.warnings.length > 0) && (
            <section className="issues" aria-label="Bloqueos y avisos">
              <ul>
                {view.blockers.map((b, i) => {
                  const name = entityName(b);
                  return (
                    <li key={`b${i}`} className="error">
                      {BLOCKER_LABEL[b.code]} {name && <strong>{name}</strong>}{' '}
                      {b.entity === 'document' && b.id && (
                        <button type="button" className="link" onClick={() => selectEvidence(b.id!, 1)}>
                          Ver documento
                        </button>
                      )}
                      {b.entity === 'field' && b.id && (
                        <button type="button" className="link" onClick={() => document.getElementById(`field-${b.id}`)?.focus()}>
                          Ir al campo
                        </button>
                      )}
                    </li>
                  );
                })}
                {view.warnings.map((w, i) => (
                  <li key={`w${i}`}>
                    {WARNING_LABEL[w.code]} <strong>{view.fields.find((f) => f.fieldId === w.fieldId)?.key}</strong>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="expediente-grid">
            <section aria-label="Documentos" className="col">
              <h3>Documentos</h3>
              <DocumentList
                documents={view.documents}
                selectedId={selectedDocumentId}
                onSelect={(id) => {
                  onSelectDocument(id);
                  setPage(1);
                }}
                onPatch={patchDocument}
                onShowInFolder={(d) => void api().showDocumentInFolder(d.documentId).then((r) => !r.ok && setError(r.error.message))}
              />
              <h4>Paquetes sin importar</h4>
              {importable.length === 0 ? (
                <p className="empty">No hay paquetes pendientes.</p>
              ) : (
                <ul className="doc-list">
                  {importable.map((p) => (
                    <li key={p.packageId}>
                      <span className="meta">
                        {p.deviceName} · {new Date(p.receivedAt).toLocaleString('es')} · {p.fileCount} archivos
                      </span>
                      <button type="button" onClick={() => void importPackage(p)}>{`Importar paquete de ${p.deviceName}`}</button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {/* Hueco del visor: la Tarea 13 lo sustituye por DocumentViewer({ document, page }). */}
            <section aria-label="Visor" className="col viewer-slot" data-testid="viewer-slot">
              {selectedDoc ? (
                <>
                  <strong>{selectedDoc.originalName}</strong>
                  <span>{page === 0 ? 'Documento completo' : `Página ${page}`}</span>
                  <span className="meta">Vista previa en la siguiente versión</span>
                </>
              ) : (
                <span className="meta">Selecciona un documento.</span>
              )}
            </section>
            <section aria-label="Campos" className="col">
              <h3>Campos</h3>
              <FieldList
                view={view}
                concepts={concepts}
                onEdit={(f) => setForm({ mode: 'edit', field: f })}
                onConfirm={(f) =>
                  void mutate(() =>
                    api().saveField(caseId!, {
                      fieldId: f.fieldId,
                      conceptId: f.conceptId,
                      variant: f.variant,
                      valor: f.valor,
                      ...(f.moneda ? { moneda: f.moneda } : {}),
                      evidence: f.evidence,
                    }),
                  )
                }
                onDelete={(f) => void mutate(() => api().deleteField(f.fieldId))}
                onEvidence={selectEvidence}
                loadHistory={(id) => api().fieldHistory(id)}
              />
              {form ? (
                <FieldForm
                  key={form.mode === 'edit' ? form.field.fieldId : 'add'}
                  concepts={concepts}
                  persons={view.persons}
                  documents={view.documents}
                  initial={form.mode === 'edit' ? form.field : undefined}
                  defaultEvidence={defaultEvidence}
                  onSave={saveField}
                  onCancel={() => setForm(undefined)}
                />
              ) : (
                <button type="button" onClick={() => setForm({ mode: 'add' })}>
                  Añadir campo
                </button>
              )}
            </section>
          </div>
          {approve && (
            <ApproveDialog view={view} error={approve.error} busy={approve.busy} onConfirm={() => void confirmApprove()} onCancel={() => setApprove(undefined)} />
          )}
        </>
      )}
      {annul && (
        <div className="overlay">
          <div role="alertdialog" aria-modal="true" aria-label="Expediente aprobado" className="dialog">
            <p>Este expediente está aprobado. Cualquier cambio anula la aprobación y habrá que volver a aprobarlo.</p>
            <div className="row">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  annul.resolve(true);
                  setAnnul(undefined);
                }}
              >
                Continuar
              </button>
              <button
                type="button"
                onClick={() => {
                  annul.resolve(false);
                  setAnnul(undefined);
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
