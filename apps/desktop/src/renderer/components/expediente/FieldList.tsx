import { useState } from 'react';
import type { CaseView, ConceptView, FieldHistoryEntry, Result } from '../../../shared/expediente-ipc.js';
import { errorText, evidenceLabel, FIELD_STATUS_LABEL, formatValue, ORIGIN_LABEL, variantLabel } from './labels.js';

type Field = CaseView['fields'][number];

export function FieldList({
  view,
  concepts,
  onEdit,
  onConfirm,
  onDelete,
  onEvidence,
  loadHistory,
}: {
  view: CaseView;
  concepts: ConceptView[];
  onEdit: (f: Field) => void;
  onConfirm: (f: Field) => void;
  onDelete: (f: Field) => void;
  onEvidence: (documentId: string, page: number) => void;
  loadHistory: (fieldId: string) => Promise<Result<FieldHistoryEntry[]>>;
}) {
  const [history, setHistory] = useState<{ fieldId: string; entries: FieldHistoryEntry[] } | { fieldId: string; error: string }>();
  if (view.fields.length === 0) return <p className="empty">Aún no hay campos.</p>;

  const groups = new Map<string, Field[]>();
  for (const f of view.fields) groups.set(f.variant, [...(groups.get(f.variant) ?? []), f]);
  const docName = (id: string) => view.documents.find((d) => d.documentId === id)?.originalName ?? 'documento desconocido';

  const toggleHistory = async (f: Field) => {
    if (history?.fieldId === f.fieldId) return setHistory(undefined);
    const r = await loadHistory(f.fieldId);
    setHistory(r.ok ? { fieldId: f.fieldId, entries: r.value } : { fieldId: f.fieldId, error: errorText(r.error) });
  };

  return (
    <div>
      {[...groups].map(([variant, fields]) => (
        <section key={variant} aria-label={variantLabel(variant, view.persons)}>
          <h4>{variantLabel(variant, view.persons)}</h4>
          <ul className="field-list">
            {fields.map((f) => {
              const c = concepts.find((x) => x.id === f.conceptId);
              return (
                <li key={f.fieldId} id={`field-${f.fieldId}`} tabIndex={-1}>
                  <div>
                    <strong>{f.key}</strong> <span className="meta">{c ? (c.labels[0] ?? '') : 'concepto desconocido'}</span>
                  </div>
                  <div className="value">{formatValue(f)}</div>
                  <div className="meta">
                    {ORIGIN_LABEL[f.origin]} · {FIELD_STATUS_LABEL[f.status]}
                  </div>
                  <div className="row wrap">
                    {f.evidence.map((e) => (
                      <button key={`${e.documentId}-${e.page}`} type="button" className="link" onClick={() => onEvidence(e.documentId, e.page)}>
                        {evidenceLabel(docName(e.documentId), e.page)}
                      </button>
                    ))}
                  </div>
                  <div className="row wrap">
                    {f.status === 'pendiente' && (
                      <button type="button" onClick={() => onConfirm(f)}>
                        {`Confirmar ${f.key}`}
                      </button>
                    )}
                    <button type="button" onClick={() => onEdit(f)}>{`Editar ${f.key}`}</button>
                    <button type="button" onClick={() => onDelete(f)}>{`Eliminar ${f.key}`}</button>
                    <button type="button" onClick={() => void toggleHistory(f)}>{`Historial de ${f.key}`}</button>
                  </div>
                  {history?.fieldId === f.fieldId &&
                    ('error' in history ? (
                      <p className="error">{history.error}</p>
                    ) : history.entries.length === 0 ? (
                      <p className="empty">Sin historial.</p>
                    ) : (
                      <ol className="history">
                        {history.entries.map((h, i) => (
                          <li key={i}>
                            {`${new Date(h.at).toLocaleString('es')} · ${h.action === 'create' ? 'alta' : h.action === 'update' ? 'corrección' : 'baja'} · rev. ${h.revision}`}
                            {h.before && h.after && ` · ${String(h.before.valor)} → ${String(h.after.valor)}`}
                          </li>
                        ))}
                      </ol>
                    ))}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
