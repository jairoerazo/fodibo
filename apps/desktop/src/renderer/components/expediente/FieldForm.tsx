import { useId, useState, type FormEvent } from 'react';
import type { CaseView, ConceptView, FieldInput, Result } from '../../../shared/expediente-ipc.js';

type Field = CaseView['fields'][number];
type EvRow = { documentId: string; page: string };

const SEP = ' — ';
const conceptText = (c: ConceptView) => `${c.id}${SEP}${c.labels[0] ?? c.id}`;

/** Resuelve lo escrito en el buscador: «id — etiqueta», solo el id o la etiqueta alemana. */
export function findConcept(concepts: ConceptView[], text: string): ConceptView | undefined {
  const t = text.trim();
  const id = t.split(SEP)[0]?.trim() ?? '';
  const lower = t.toLowerCase();
  return concepts.find((c) => c.id === id) ?? concepts.find((c) => c.labels.some((l) => l.toLowerCase() === lower));
}

/** Alta o corrección de un campo. La validación definitiva es del núcleo: sus errores se muestran junto al control (`details.field`). */
export function FieldForm({
  concepts,
  persons,
  documents,
  initial,
  defaultEvidence,
  onSave,
  onCancel,
}: {
  concepts: ConceptView[];
  persons: CaseView['persons'];
  documents: CaseView['documents'];
  initial?: Field;
  defaultEvidence?: { documentId: string; page: number };
  onSave: (input: FieldInput) => Promise<Result<CaseView>>;
  onCancel: () => void;
}) {
  const uid = useId();
  const editing = initial !== undefined;
  const initialConcept = initial ? concepts.find((c) => c.id === initial.conceptId) : undefined;
  const [concept, setConcept] = useState(initialConcept ? conceptText(initialConcept) : (initial?.conceptId ?? ''));
  const [variant, setVariant] = useState(initial?.variant ?? '');
  const [text, setText] = useState(typeof initial?.valor === 'string' ? initial.valor : '');
  const [flag, setFlag] = useState(initial?.valor === true);
  const [rows, setRows] = useState<EvRow[]>(
    initial
      ? initial.evidence.map((e) => ({ documentId: e.documentId, page: String(e.page) }))
      : defaultEvidence
        ? [{ documentId: defaultEvidence.documentId, page: String(defaultEvidence.page) }]
        : [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const resolved = findConcept(concepts, concept);
  const tipo = resolved?.tipo ?? initial?.tipo;
  const usable = documents.filter((d) => d.status !== 'descartado');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!resolved && !editing) {
      setErrors({ conceptId: 'Elige un concepto del catálogo.' });
      return;
    }
    const conceptId = resolved?.id ?? initial!.conceptId;
    const evidence = rows.filter((r) => r.documentId).map((r) => ({ documentId: r.documentId, page: Number(r.page === '' ? 0 : r.page) }));
    const input: FieldInput = {
      ...(initial ? { fieldId: initial.fieldId } : {}),
      conceptId,
      variant: resolved?.variants || (editing && variant) ? variant : '',
      valor: tipo === 'boolean' ? flag : text,
      ...(tipo === 'amount' ? { moneda: 'CHF' } : {}),
      evidence,
    };
    setBusy(true);
    const r = await onSave(input);
    setBusy(false);
    if (r.ok) return;
    const f = (r.error.details as { field?: string } | undefined)?.field;
    const key = f === 'moneda' ? 'valor' : f === 'conceptId' || f === 'variant' || f === 'evidence' || f === 'valor' ? f : 'form';
    setErrors({ [key]: r.error.message });
  };

  const err = (key: string) => (errors[key] ? <p id={`${uid}-${key}`} className="field-error">{errors[key]}</p> : null);
  const aria = (key: string) => ({ 'aria-invalid': errors[key] ? true : undefined, 'aria-describedby': errors[key] ? `${uid}-${key}` : undefined });
  const patchRow = (i: number, p: Partial<EvRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <form className="form-card" onSubmit={(e) => void submit(e)} aria-label={editing ? 'Editar campo' : 'Añadir campo'}>
      <label>
        Concepto
        <input list={`${uid}-concepts`} value={concept} disabled={editing} onChange={(e) => setConcept(e.target.value)} {...aria('conceptId')} />
      </label>
      <datalist id={`${uid}-concepts`}>
        {concepts.map((c) => (
          <option key={c.id} value={conceptText(c)} />
        ))}
      </datalist>
      {err('conceptId')}
      {(resolved?.variants || (editing && initial?.variant)) && (
        <>
          <label>
            Persona o variante
            <select value={variant} disabled={editing} onChange={(e) => setVariant(e.target.value)} {...aria('variant')}>
              <option value="">— elige —</option>
              {persons.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {`${p.label} (${p.slug})`}
                </option>
              ))}
              <option value="familie">Familie (hogar)</option>
            </select>
          </label>
          {err('variant')}
        </>
      )}
      {tipo === 'boolean' ? (
        <label className="inline">
          <input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} {...aria('valor')} />
          Valor
        </label>
      ) : tipo === 'enum' ? (
        <label>
          Valor
          <select value={text} onChange={(e) => setText(e.target.value)} {...aria('valor')}>
            <option value="">— elige —</option>
            {(resolved?.values ?? []).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="row amount-row">
          <label>
            Valor
            <input
              value={text}
              placeholder={tipo === 'date' ? 'DD.MM.AAAA' : tipo === 'amount' ? "1'234.50" : undefined}
              onChange={(e) => setText(e.target.value)}
              {...aria('valor')}
            />
          </label>
          {tipo === 'amount' && <span className="currency">CHF</span>}
        </div>
      )}
      {err('valor')}
      <fieldset {...aria('evidence')}>
        <legend>Evidencias</legend>
        {rows.map((r, i) => (
          <div className="row" key={i}>
            <label>
              {`Documento de la evidencia ${i + 1}`}
              <select value={r.documentId} onChange={(e) => patchRow(i, { documentId: e.target.value })}>
                <option value="">— elige —</option>
                {usable.map((d) => (
                  <option key={d.documentId} value={d.documentId}>
                    {d.originalName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {`Página de la evidencia ${i + 1}`}
              <input type="number" min={0} max={9999} value={r.page} onChange={(e) => patchRow(i, { page: e.target.value })} />
            </label>
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              {`Quitar evidencia ${i + 1}`}
            </button>
          </div>
        ))}
        <button type="button" onClick={() => setRows([...rows, { documentId: defaultEvidence?.documentId ?? '', page: '1' }])}>
          Añadir evidencia
        </button>
        <p className="hint">Página 0 = documento completo.</p>
      </fieldset>
      {err('evidence')}
      {err('form')}
      <div className="row">
        <button type="submit" disabled={busy}>
          Guardar campo
        </button>
        <button type="button" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
