import { useId, useState, type FormEvent } from 'react';
import type { CaseInput, Result, CaseView } from '../../../shared/expediente-ipc.js';
import { CANTONS } from '../../../core/expediente/types.js';
import { errorText } from './labels.js';

/** Alta de expediente: ejercicio, cantón y personas (titular obligatorio; pareja e hijos opcionales). */
export function NewCaseForm({ onCreate, onCancel }: { onCreate: (input: CaseInput) => Promise<Result<CaseView>>; onCancel: () => void }) {
  const uid = useId();
  const [year, setYear] = useState(String(new Date().getFullYear() - 1));
  const [canton, setCanton] = useState<string>('ZH');
  const [haupt, setHaupt] = useState('');
  const [partner, setPartner] = useState('');
  const [kids, setKids] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!haupt.trim()) next.haupt = 'Indica el nombre del titular.';
    if (!/^\d{4}$/.test(year.trim())) next.year = 'El año fiscal debe tener cuatro cifras.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const persons: CaseInput['persons'] = [{ role: 'hauptperson', label: haupt.trim() }];
    if (partner.trim()) persons.push({ role: 'partner', label: partner.trim() });
    for (const k of kids) if (k.trim()) persons.push({ role: 'kind', label: k.trim() });
    setBusy(true);
    const r = await onCreate({ taxYear: Number(year), jurisdiction: canton as CaseInput['jurisdiction'], persons });
    setBusy(false);
    if (!r.ok) {
      const f = (r.error.details as { field?: string } | undefined)?.field;
      setErrors({ [f === 'taxYear' ? 'year' : f === 'jurisdiction' ? 'canton' : 'form']: errorText(r.error) });
    }
  };

  const err = (key: string) => (errors[key] ? <p id={`${uid}-${key}`} className="field-error" role="alert">{errors[key]}</p> : null);
  const aria = (key: string) => ({ 'aria-invalid': errors[key] ? true : undefined, 'aria-describedby': errors[key] ? `${uid}-${key}` : undefined });

  return (
    <form className="form-card" onSubmit={(e) => void submit(e)} aria-label="Nuevo expediente">
      <label>
        Año fiscal
        <input type="number" value={year} onChange={(e) => setYear(e.target.value)} {...aria('year')} />
      </label>
      {err('year')}
      <label>
        Cantón
        <select value={canton} onChange={(e) => setCanton(e.target.value)} {...aria('canton')}>
          {CANTONS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      {err('canton')}
      <label>
        Titular
        <input value={haupt} onChange={(e) => setHaupt(e.target.value)} {...aria('haupt')} />
      </label>
      {err('haupt')}
      <label>
        Pareja (opcional)
        <input value={partner} onChange={(e) => setPartner(e.target.value)} />
      </label>
      {kids.map((k, i) => (
        <label key={i}>
          {`Hijo ${i + 1}`}
          <input value={k} onChange={(e) => setKids(kids.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      <button type="button" onClick={() => setKids([...kids, ''])}>
        Añadir hijo
      </button>
      {err('form')}
      <div className="row">
        <button type="submit" disabled={busy}>
          Crear expediente
        </button>
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
