import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentState, FieldResult, PendingReason } from '../../core/agent/index.js';
import type { AgentUiEvent } from '../../shared/agent-ipc.js';
import { cleanIpcError } from '../format.js';

export const REASON_TEXT: Record<PendingReason, string> = {
  sin_dato: 'No hay dato en la declaración',
  ambiguo: 'Varios candidatos',
  tipo_incompatible: 'El dato no encaja con el campo',
  no_verificado: 'No se pudo verificar',
  valor_previo_distinto: 'Ya tenía un valor distinto',
  modelo_sin_respuesta: 'El modelo no respondió',
  error_portal: 'Error del portal',
};

const STATE_TEXT: Record<AgentState, string> = {
  inactivo: 'Inactivo',
  rellenando: 'Rellenando',
  entregado: 'Entregado',
  detenido: 'Detenido',
  error: 'Error',
};

const MODEL_TEXT = { arrancando: 'Arrancando…', listo: 'Listo', error: 'Error' } as const;

interface LogLine {
  at: string;
  text: string;
}

function groupByStep(pending: FieldResult[]): { step: number; title: string; items: FieldResult[] }[] {
  const groups = new Map<number, { step: number; title: string; items: FieldResult[] }>();
  for (const r of pending) {
    const g = groups.get(r.step) ?? { step: r.step, title: r.stepTitle, items: [] };
    g.items.push(r);
    groups.set(r.step, g);
  }
  return [...groups.values()].sort((a, b) => a.step - b.step);
}

export function AgentPanel({ visible }: { visible: boolean }) {
  const [modelStatus, setModelStatus] = useState<keyof typeof MODEL_TEXT>();
  const [agentState, setAgentState] = useState<AgentState>('inactivo');
  const [stateMessage, setStateMessage] = useState<string>();
  const [step, setStep] = useState<{ n: number; total?: number }>();
  const [log, setLog] = useState<LogLine[]>([]);
  const [pending, setPending] = useState<FieldResult[]>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [portalOpen, setPortalOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(
    () =>
      window.fodiboAgent.onEvent((e: AgentUiEvent) => {
        if (e.type === 'model') {
          setModelStatus(e.status);
          setError(e.status === 'error' ? (e.message ?? 'Error del modelo') : undefined);
        } else if (e.type === 'state') {
          setAgentState(e.state);
          setStateMessage(e.message);
          setStep(e.state === 'rellenando' && e.step !== undefined ? { n: e.step, ...(e.total !== undefined ? { total: e.total } : {}) } : undefined);
        } else if (e.type === 'log') {
          setLog((prev) => [...prev, { at: e.at, text: e.text }]);
        } else if (e.type === 'finished') {
          setPending(e.pending);
          setRunning(false);
        }
      }),
    [],
  );

  // Oculta, la vista no se encoge (setVisible(false) conserva su tamaño): un hueco de 0×0 haría
  // fallar `elementFromPoint` y el agente no podría seguir si el usuario cambia de pestaña.
  const sendBounds = useCallback(() => {
    const el = holder.current;
    if (!visibleRef.current || !el) return;
    const r = el.getBoundingClientRect();
    window.fodiboAgent.setBounds({
      x: Math.max(0, r.x),
      y: Math.max(0, r.y),
      width: Math.max(0, r.width),
      height: Math.max(0, r.height),
    });
  }, []);

  useEffect(() => {
    sendBounds();
    window.fodiboAgent.setVisible(visible);
    const el = holder.current;
    if (!el || !visible) return;
    const ro = new ResizeObserver(sendBounds);
    ro.observe(el);
    window.addEventListener('resize', sendBounds);
    window.addEventListener('scroll', sendBounds, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sendBounds);
      window.removeEventListener('scroll', sendBounds, true);
    };
  }, [visible, portalOpen, sendBounds]);

  // El contenido variable de encima (error, estado) puede desplazar o encoger el hueco.
  useLayoutEffect(() => {
    sendBounds();
  }, [error, log, pending, agentState, stateMessage, step, modelStatus, sendBounds]);

  const open = async () => {
    setError(undefined);
    try {
      await window.fodiboAgent.openPortal();
      setPortalOpen(true);
    } catch (err) {
      setError(cleanIpcError(err));
    }
  };

  const start = async () => {
    setError(undefined);
    setPending(undefined);
    setLog([]);
    // El estado de la ejecución anterior (p. ej. un error) no debe verse como el de la nueva.
    setAgentState('inactivo');
    setStateMessage(undefined);
    setStep(undefined);
    setRunning(true);
    try {
      await window.fodiboAgent.start();
    } catch (err) {
      setError(cleanIpcError(err));
    }
    setRunning(false);
  };

  const stop = () => {
    window.fodiboAgent.stop().catch((err: unknown) => setError(cleanIpcError(err)));
  };

  const stepText = step ? ` · Paso ${step.n}${step.total !== undefined ? `/${step.total}` : ''}` : '';

  return (
    <section hidden={!visible} aria-label="Prueba de portal" className="agent-panel">
      <div className="agent-controls">
        <div className="row">
          <button type="button" onClick={() => void open()}>
            Abrir portal
          </button>
          <button type="button" onClick={() => void start()} disabled={running}>
            Iniciar agente
          </button>
          <button type="button" onClick={stop}>
            Detener
          </button>
        </div>
        <p className="status">
          Modelo: {modelStatus ? MODEL_TEXT[modelStatus] : 'sin iniciar'} · Agente: {STATE_TEXT[agentState]}
          {stepText}
          {stateMessage ? ` — ${stateMessage}` : ''}
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <div className="agent-body">
        <div ref={holder} className="portal-holder" aria-label="Vista del portal" />
        {/* Los pendientes (lo que el usuario debe completar) van antes que el registro. */}
        <section className="agent-side" aria-label="Registro y pendientes">
          {log.length === 0 && !pending && <p className="empty">Sin actividad.</p>}
          {pending && (
            <div className="pending">
              {pending.length === 0 ? agentState === 'entregado' && <p>No quedan pendientes.</p> : <h3>Pendientes</h3>}
              {groupByStep(pending).map((g) => (
                <div key={g.step} className="card">
                  <h4>
                    <span>Paso {g.step}</span> · <span>{g.title}</span>
                  </h4>
                  <ul>
                    {g.items.map((r) => (
                      <li key={r.field_id}>
                        <strong>{r.label}</strong>
                        {r.outcome.kind === 'pending' && (
                          <>
                            {' — '}
                            {REASON_TEXT[r.outcome.reason]}
                            {r.outcome.candidates.length > 0 && (
                              <ul>
                                {r.outcome.candidates.map((c) => (
                                  <li key={c.key}>{`${c.key}: ${c.valor}`}</li>
                                ))}
                              </ul>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p>Control entregado. Completa los pendientes, revisa y pulsa «Einreichen».</p>
            </div>
          )}
          {log.length > 0 && (
            <ul className="agent-log">
              {log.map((l, i) => (
                <li key={i}>{l.text}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
