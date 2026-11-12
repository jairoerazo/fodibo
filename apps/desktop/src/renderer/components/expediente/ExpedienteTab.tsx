import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseInput, CaseSummary, CaseView, ConceptView, DocumentPatch, FieldInput, ImportablePackage, ImportResult, Result } from '../../../shared/expediente-ipc.js';
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
  pendingImport,
  onImportResult,
}: {
  caseId: string | undefined;
  onSelectCase: (caseId: string | undefined) => void;
  selectedDocumentId: string | undefined;
  onSelectDocument: (documentId: string | undefined) => void;
  /** Importación pedida desde otra pestaña: pasa por la misma guarda de «anula la aprobación». `seq` distingue peticiones repetidas. */
  pendingImport?: { packageId: string; seq: number };
  onImportResult?: (r: Result<ImportResult>) => void;
}) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  /** Solo 'ok' autoriza a concluir que un expediente recordado ya no existe; un fallo transitorio no debe borrarlo. */
  const [casesState, setCasesState] = useState<'loading' | 'ok' | 'failed'>('loading');
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
  // Secuencia de peticiones sobre la vista: una respuesta solo se aplica si es de este expediente y más nueva que la última aplicada.
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const applyView = (id: string, seq: number, v: CaseView): boolean => {
    if (id !== caseIdRef.current || seq <= appliedRef.current) return false;
    appliedRef.current = seq;
    setView(v);
    return true;
  };
  const api = () => window.fodiboExpediente;

  const loadCases = useCallback(async () => {
    const r = await api().listCases();
    if (r.ok) {
      setCases(r.value);
      setCasesState('ok');
    } else {
      setCasesState('failed');
      setError(r.error.message);
    }
  }, []);
  const loadImportable = useCallback(async () => {
    const r = await api().listImportable();
    if (r.ok) setImportable(r.value);
    else setError(r.error.message);
  }, []);
  const loadView = useCallback(async (id: string) => {
    const seq = ++seqRef.current;
    const r = await api().getCase(id);
    if (id !== caseIdRef.current) return;
    if (r.ok) applyView(id, seq, r.value);
    else setError(r.error.message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Lo que estuviera en vuelo para otro expediente queda obsoleto.
    appliedRef.current = ++seqRef.current;
    if (!caseId || casesState === 'loading') return;
    if (casesState === 'ok' && !cases.some((c) => c.caseId === caseId)) onSelectCase(undefined);
    else void loadView(caseId);
    // La lista entra solo por su estado de carga; recargarla no debe recargar la vista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, casesState === 'loading']);

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
    const id = caseIdRef.current;
    const seq = ++seqRef.current;
    const r = await call();
    if (id !== caseIdRef.current) return r;
    if (r.ok) {
      applyView(id!, seq, r.value);
      setError(undefined);
    } else if (!quiet) setError(r.error.message);
    return r;
  };

  const createCase = async (input: CaseInput): Promise<Result<CaseView>> => {
    const r = await api().createCase(input);
    if (r.ok) {
      await loadCases();
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

  const importById = async (packageId: string) => {
    const id = caseIdRef.current;
    if (!id || !(await guard())) return;
    const r = await api().importPackage(id, packageId);
    onImportResult?.(r);
    if (id !== caseIdRef.current) return;
    if (!r.ok) return setError(r.error.message);
    setError(undefined);
    await Promise.all([loadView(id), loadImportable()]);
  };

  // Importación pedida desde la pestaña de paquetes: misma guarda que las demás ediciones.
  const handledImport = useRef(0);
  useEffect(() => {
    if (!pendingImport || pendingImport.seq === handledImport.current) return;
    handledImport.current = pendingImport.seq;
    void importById(pendingImport.packageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingImport]);

  const saveField = (input: FieldInput) =>
    mutate(() => api().saveField(caseId!, input), true).then((r) => {
      if (r.ok) setForm(undefined);
      return r;
    });

  const confirmApprove = async () => {
    if (!view || !caseId) return;
    const id = caseId;
    setApprove({ busy: true });
    const r = await api().approve(id, view.revision);
    if (id !== caseIdRef.current) return;
    // approve no emite case-changed (no sube la revisión): se refresca a mano.
    await loadView(id);
    if (id !== caseIdRef.current) return;
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
                      <button type="button" onClick={() => void importById(p.packageId)}>{`Importar paquete de ${p.deviceName}`}</button>
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
