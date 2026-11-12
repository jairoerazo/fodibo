import type { CaseSummary, CaseView } from '../../../shared/expediente-ipc.js';
import { CASE_STATUS_LABEL } from './labels.js';

export function CaseHeader({
  cases,
  caseId,
  view,
  onSelectCase,
  onNew,
  onApprove,
}: {
  cases: CaseSummary[];
  caseId: string | undefined;
  view: CaseView | undefined;
  onSelectCase: (caseId: string | undefined) => void;
  onNew: () => void;
  onApprove: () => void;
}) {
  const a = view?.lastApproval;
  return (
    <header className="case-header">
      <label>
        Expediente
        <select value={caseId ?? ''} onChange={(e) => onSelectCase(e.target.value || undefined)}>
          <option value="">— ninguno —</option>
          {cases.map((c) => (
            <option key={c.caseId} value={c.caseId}>
              {`${c.taxYear} ${c.jurisdiction} · ${c.hauptpersonLabel ?? 'sin titular'}`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onNew}>
        Nuevo expediente
      </button>
      {view && (
        <>
          <span className={`badge badge-${view.status}`}>{CASE_STATUS_LABEL[view.status]}</span>
          <span>{`Revisión ${view.revision}`}</span>
          {view.status === 'aprobado' && a && (
            <span title={a.contentHash}>
              {`Aprobado el ${new Date(a.approvedAt).toLocaleString('es')} · huella ${a.contentHash.slice(0, 12)}`}
            </span>
          )}
          <button type="button" onClick={onApprove}>
            Aprobar
          </button>
        </>
      )}
    </header>
  );
}
