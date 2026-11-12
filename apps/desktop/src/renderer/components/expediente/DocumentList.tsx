import type { CaseView, DocumentPatch } from '../../../shared/expediente-ipc.js';
import { DOC_TYPES } from '../../../core/expediente/types.js';
import { DOC_STATUS_LABEL, DOC_TYPE_LABEL } from './labels.js';

type Doc = CaseView['documents'][number];
type Patch = DocumentPatch;

export function DocumentList({
  documents,
  selectedId,
  onSelect,
  onPatch,
  onShowInFolder,
}: {
  documents: Doc[];
  selectedId: string | undefined;
  onSelect: (documentId: string) => void;
  onPatch: (doc: Doc, patch: Patch) => void;
  onShowInFolder: (doc: Doc) => void;
}) {
  if (documents.length === 0) return <p className="empty">Este expediente aún no tiene documentos.</p>;
  return (
    <ul className="doc-list">
      {documents.map((d) => (
        <li key={d.documentId} className={d.documentId === selectedId ? 'selected' : undefined}>
          <button type="button" className="link" aria-pressed={d.documentId === selectedId} onClick={() => onSelect(d.documentId)}>
            {d.originalName}
          </button>
          <span className="meta">
            {DOC_STATUS_LABEL[d.status]} · {d.sourceDevice} · {new Date(d.importedAt).toLocaleDateString('es')}
          </span>
          {!d.available && <span className="error">Falta el original en el almacén.</span>}
          <label>
            {`Tipo de ${d.originalName}`}
            <select value={d.docType ?? ''} onChange={(e) => e.target.value && onPatch(d, { docType: e.target.value as Patch['docType'] })}>
              <option value="">— sin tipo —</option>
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOC_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <span className="row">
            {d.status === 'pendiente_de_revision' && (
              <button type="button" disabled={d.docType === null} title={d.docType === null ? 'Asigna primero un tipo.' : undefined} onClick={() => onPatch(d, { status: 'confirmado' })}>
                Revisado
              </button>
            )}
            {d.status === 'confirmado' && (
              <button type="button" onClick={() => onPatch(d, { status: 'pendiente_de_revision' })}>
                Reabrir
              </button>
            )}
            {d.status !== 'descartado' && (
              <button type="button" onClick={() => onPatch(d, { status: 'descartado' })}>
                Descartar
              </button>
            )}
            {d.status === 'descartado' && (
              <button type="button" onClick={() => onPatch(d, { status: 'pendiente_de_revision' })}>
                Recuperar
              </button>
            )}
            <button type="button" onClick={() => onShowInFolder(d)}>
              Mostrar en la carpeta
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}
