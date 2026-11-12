import { useEffect, useRef, useState } from 'react';
import type { CaseView } from '../../../shared/expediente-ipc.js';
import { BLOCKER_LABEL, evidenceLabel, formatValue } from './labels.js';

/** Muestra la tabla exacta que se proyectará (solo campos confirmados), los avisos y los bloqueos. */
export function ApproveDialog({ view, error, busy, onConfirm, onCancel }: { view: CaseView; error?: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [ack, setAck] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>('button, input')?.focus(), []);

  const confirmed = view.fields.filter((f) => f.status === 'confirmado');
  const docName = (id: string) => view.documents.find((d) => d.documentId === id)?.originalName ?? 'documento desconocido';
  const blocked = view.blockers.length > 0;
  const needsAck = view.warnings.length > 0;
  const warnKeys = view.warnings.map((w) => view.fields.find((f) => f.fieldId === w.fieldId)?.key ?? w.fieldId);

  return (
    <div className="overlay">
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Aprobar expediente" className="dialog" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
        <h3>Aprobar expediente</h3>
        {blocked && (
          <div>
            <p className="error">No se puede aprobar todavía:</p>
            <ul>
              {view.blockers.map((b, i) => (
                <li key={i}>{BLOCKER_LABEL[b.code]}</li>
              ))}
            </ul>
          </div>
        )}
        <table>
          <caption>Esto es lo que se aprobará</caption>
          <thead>
            <tr>
              <th scope="col">Clave</th>
              <th scope="col">Valor</th>
              <th scope="col">Evidencias</th>
            </tr>
          </thead>
          <tbody>
            {confirmed.map((f) => (
              <tr key={f.fieldId}>
                <td>{f.key}</td>
                <td>{formatValue(f)}</td>
                <td>{f.evidence.length === 0 ? '—' : f.evidence.map((e) => evidenceLabel(docName(e.documentId), e.page)).join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {needsAck && (
          <label className="inline">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {`Aprobar aun así: estos campos no tienen evidencia (${warnKeys.join(', ')}).`}
          </label>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row">
          <button type="button" disabled={blocked || busy || (needsAck && !ack)} onClick={onConfirm}>
            Aprobar
          </button>
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
