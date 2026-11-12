import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseInput, CaseSummary, CaseView, ConceptView, DocumentPatch, FieldInput, ImportablePackage, ImportResult, Result } from '../../../shared/expediente-ipc.js';
import { ApproveDialog } from './ApproveDialog.js';
import { CaseHeader } from './CaseHeader.js';
import { DocumentViewer } from './DocumentViewer.js';
import { DocumentList } from './DocumentList.js';
import { FieldForm } from './FieldForm.js';
import { FieldList } from './FieldList.js';
import { BLOCKER_LABEL, errorText, WARNING_LABEL } from './labels.js';
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
  visible = true,
  receivedCount = 0,
}: {
  caseId: string | undefined;
  onSelectCase: (caseId: string | undefined) => void;
  selectedDocumentId: string | undefined;
  onSelectDocument: (documentId: string | undefined) => void;
  /** Importación pedida desde otra pestaña: pasa por la misma guarda de «anula la aprobación». `seq` distingue peticiones repetidas. */
  pendingImport?: { packageId: string; seq: number };
  onImportResult?: (r: Result<ImportResult>) => void;
  /** Si la pestaña está a la vista: al mostrarse se recargan los paquetes sin importar. */
  visible?: boolean;
  /** Cambia cada vez que llega un paquete: recarga los paquetes sin importar si la pestaña está a la vista. */
  receivedCount?: number;
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
  // Copia síncrona del aviso pendiente: permite resolverlo al cambiar de expediente o al pedir otro.
  const annulRef = useRef<{ resolve: (ok: boolean) => void } | undefined>(undefined);
  const settleAnnul = (ok: boolean) => {
    const pending = annulRef.current;
    annulRef.current = undefined;
    setAnnul(undefined);
    pending?.resolve(ok);
  };
  const viewRef = useRef<CaseView | undefined>(undefined);
  viewRef.current = view;
  const caseIdRef = useRef(caseId);
  caseIdRef.current = caseId;
  // Secuencia de peticiones sobre la vista: una respuesta solo se aplica si es de este expediente y más nueva que la última aplicada.
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const applyView = (id: string, seq: number, v: CaseView): boolean => {
    // La vista debe ser del expediente pedido y del que se muestra: nunca se pinta la de otro.
    if (id !== caseIdRef.current || v.caseId !== id || seq <= appliedRef.current) return false;
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
      setError(errorText(r.error));
    }
  }, []);
  const loadImportable = useCallback(async () => {
    const r = await api().listImportable();
    if (r.ok) setImportable(r.value);
    else setError(errorText(r.error));
  }, []);
  const loadView = useCallback(async (id: string) => {
    const seq = ++seqRef.current;
    const r = await api().getCase(id);
    if (id !== caseIdRef.current) return;
    if (r.ok) applyView(id, seq, r.value);
    else setError(errorText(r.error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadCases();
    void api().listConcepts().then((r) => (r.ok ? setConcepts(r.value) : setError(errorText(r.error))));
  }, [loadCases]);

  // Los paquetes sin importar cambian fuera de esta pestaña: se recargan al mostrarla y al llegar uno nuevo.
  useEffect(() => {
    if (visible) void loadImportable();
  }, [visible, receivedCount, loadImportable]);

  // Un expediente recordado que ya no existe se descarta en silencio.
  useEffect(() => {
    setView(undefined);
    setForm(undefined);
    setApprove(undefined);
    // Un aviso de «anula la aprobación» era para el expediente anterior: se cancela.
    settleAnnul(false);
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

  /**
   * Un expediente aprobado avisa antes del primer cambio: editarlo anula la aprobación (spec §10.1).
   * Solo autoriza si `id` sigue siendo el expediente mostrado al resolverse; sin vista cargada se consulta antes de decidir.
   */
  const guard = async (id: string): Promise<boolean> => {
    let current = viewRef.current;
    if (!current || current.caseId !== id) {
      const r = await api().getCase(id);
      if (id !== caseIdRef.current) return false;
      if (!r.ok) {
        setError(errorText(r.error));
        return false;
      }
      current = r.value;
    }
    if (current.status === 'aprobado') {
      // Un aviso anterior aún abierto se cancela: nunca queda una promesa colgada.
      settleAnnul(false);
      const ok = await new Promise<boolean>((resolve) => {
        annulRef.current = { resolve };
        setAnnul(annulRef.current);
      });
      if (!ok) return false;
    }
    return id === caseIdRef.current;
  };

  /** `call` recibe el expediente leído ANTES del aviso; si mientras tanto cambió el mostrado, no se escribe nada. */
  const mutate = async (call: (id: string) => Promise<Result<CaseView>>, quiet = false): Promise<Result<CaseView>> => {
    const id = caseIdRef.current;
    if (!id || !(await guard(id))) return CANCELLED;
    const seq = ++seqRef.current;
    const r = await call(id);
    if (id !== caseIdRef.current) return r;
    if (r.ok) {
      applyView(id, seq, r.value);
      setError(undefined);
    } else if (!quiet) setError(errorText(r.error));
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
    if (!id || !(await guard(id))) return;
    const r = await api().importPackage(id, packageId);
    onImportResult?.(r);
    if (id !== caseIdRef.current) return;
    if (!r.ok) return setError(errorText(r.error));
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
    mutate((id) => api().saveField(id, input), true).then((r) => {
      if (r.ok) setForm(undefined);
      return r;
    });

  /** Se aprueba exactamente la vista mostrada en el diálogo (spec §8.1): su expediente y su revisión. */
  const confirmApprove = async () => {
    if (!view || view.caseId !== caseIdRef.current) return;
    const id = view.caseId;
    setApprove({ busy: true });
    const r = await api().approve(id, view.revision);
    if (id !== caseIdRef.current) return;
    // approve no emite case-changed (no sube la revisión): se refresca a mano.
    await loadView(id);
    if (id !== caseIdRef.current) return;
    if (r.ok) setApprove(undefined);
    else setApprove({ busy: false, error: errorText(r.error) });
  };

  const selectEvidence = (documentId: string, p: number) => {
    onSelectDocument(documentId);
    setPage(p);
  };
  const selectedDoc = view?.documents.find((d) => d.documentId === selectedDocumentId);
  const defaultEvidence = selectedDoc && selectedDoc.status !== 'descartado' ? { documentId: selectedDoc.documentId, page } : undefined;
  const entityName = (b: CaseView['blockers'][number]) =>
    b.entity === 'document' ? view?.documents.find((d) => d.documentId === b.id)?.originalName : b.entity === 'field' ? view?.fields.find((f) => f.fieldId === b.id)?.key : undefined;

  // Con un diálogo abierto el resto de la pestaña queda inerte: ni el teclado puede cambiar de expediente por debajo.
  const dialogOpen = Boolean(annul || (view && approve));

  return (
    <div className="expediente">
      <div className="expediente-body" inert={dialogOpen}>
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
                onShowInFolder={(d) => void api().showDocumentInFolder(d.documentId).then((r) => !r.ok && setError(errorText(r.error)))}
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
            <section aria-label="Visor" className="col viewer-slot" data-testid="viewer-slot">
              {selectedDoc ? (
                <>
                  <strong>{selectedDoc.originalName}</strong>
                  {selectedDoc.available ? (
                    <DocumentViewer document={{ documentId: selectedDoc.documentId, mime: selectedDoc.mime }} page={page === 0 ? undefined : page} />
                  ) : (
                    <span className="error">Original no disponible</span>
                  )}
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
                  void mutate((id) =>
                    api().saveField(id, {
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
        </>
      )}
      </div>
      {view && approve && (
        <ApproveDialog view={view} error={approve.error} busy={approve.busy} onConfirm={() => void confirmApprove()} onCancel={() => setApprove(undefined)} />
      )}
      {annul && (
        <div className="overlay">
          <div role="alertdialog" aria-modal="true" aria-label="Expediente aprobado" className="dialog">
            <p>Este expediente está aprobado. Cualquier cambio anula la aprobación y habrá que volver a aprobarlo.</p>
            <div className="row">
              <button
                type="button"
                autoFocus
                onClick={() => settleAnnul(true)}
              >
                Continuar
              </button>
              <button
                type="button"
                onClick={() => settleAnnul(false)}
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
