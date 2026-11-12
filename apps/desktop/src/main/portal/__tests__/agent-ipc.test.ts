import { describe, expect, it } from 'vitest';
import type { AgentUiEvent } from '../../../shared/agent-ipc.js';
import { ExpedienteError } from '../../../core/expediente/index.js';
import { AgentController, APPROVAL_MESSAGES, createLlamaFromEnv, registerAgentIpc, type AdapterLike, type AgentDeps, type ViewLike } from '../agent-ipc.js';

const CASE = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
const APPROVAL = { caseId: CASE, caseRevision: 7, approvedAt: '2026-11-12T10:00:00.000Z', contentHash: 'a'.repeat(64) };

function setup(
  opts: {
    blocked?: () => number;
    llamaStart?: () => Promise<string>;
    modelComplete?: () => Promise<unknown>;
    hang?: boolean;
    attach?: () => Promise<void>;
    loadDeclaration?: AgentDeps['loadDeclaration'];
  } = {},
) {
  const calls: string[] = [];
  const events: AgentUiEvent[] = [];
  let blockedCb: (() => void) | undefined;
  const view: ViewLike = {
    load: async () => void calls.push('load'),
    setBounds: (r) => void calls.push(`bounds:${r.width}`),
    setVisible: (v) => void calls.push(`visible:${v}`),
    setAgentActive: (a) => void calls.push(`active:${a}`),
    get blockedSubmits() {
      return opts.blocked?.() ?? 0;
    },
    onSubmitBlocked: (cb) => void (blockedCb = cb),
    destroy: () => void calls.push('destroy'),
  };
  const adapter: AdapterLike = {
    attach: async () => {
      calls.push('attach');
      await opts.attach?.();
    },
    detach: () => void calls.push('detach'),
    observarPaso: async () => {
      calls.push('observe');
      if (opts.hang) await new Promise((r) => setTimeout(r, 200));
      return { index: 1, total: 1, title: 't', isSummary: true, fields: [], errors: [] };
    },
    rellenarCampo: async () => {},
    leerCampo: async () => '',
    avanzarPaso: async () => {},
  };
  let cancelStart: (() => void) | undefined;
  const llama = {
    start: opts.llamaStart ?? (async () => 'http://127.0.0.1:1'),
    stop: async () => {
      calls.push('llama-stop');
      cancelStart?.();
    },
  };
  const c = new AgentController({
    createView: () => ({ view, adapter }),
    getLlama: () => llama,
    createModel: () => ({ complete: opts.modelComplete ?? (async () => ({})) }),
    loadDeclaration: opts.loadDeclaration ?? (() => ({ declaration: {}, approval: APPROVAL })),
    emit: (e) => {
      events.push(e);
      if (e.type === 'finished' || e.type === 'state') calls.push(`ev:${e.type}`);
    },
  });
  return { c, calls, events, trigger: () => blockedCb?.() };
}

describe('AgentController', () => {
  it('sin modelo: evento de error y rechazo legible, sin adjuntar el depurador', async () => {
    const llama = createLlamaFromEnv({});
    const { c, events, calls } = setup({ llamaStart: () => llama.start() });
    await c.openPortal();
    await expect(c.start(CASE)).rejects.toThrow('No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.');
    expect(events).toContainEqual({
      type: 'model',
      status: 'error',
      message: 'No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.',
    });
    expect(calls).not.toContain('attach');
    expect(c.isRunning).toBe(false);
  });

  it('entrega: detach, luego setAgentActive(false), luego eventos finales', async () => {
    const { c, calls, events } = setup();
    await c.openPortal();
    await c.start(CASE);
    const i = (s: string) => calls.indexOf(s);
    expect(i('attach')).toBeGreaterThan(i('active:true'));
    expect(i('detach')).toBeGreaterThan(i('attach'));
    expect(i('active:false')).toBeGreaterThan(i('detach'));
    expect(i('ev:finished')).toBeGreaterThan(i('active:false'));
    expect(events.filter((e) => e.type === 'finished')).toHaveLength(1);
    expect(c.isRunning).toBe(false);
  });

  it('rechaza un segundo start en curso y stop sin ejecución es inocuo', async () => {
    let release!: (u: string) => void;
    const { c } = setup({ llamaStart: () => new Promise<string>((r) => (release = r)) });
    c.stop();
    await c.openPortal();
    const first = c.start(CASE);
    await expect(c.start(CASE)).rejects.toThrow('Ya hay una ejecución en curso.');
    release('http://127.0.0.1:1');
    await first;
  });

  it('start sin portal abierto: error legible', async () => {
    const { c } = setup();
    await expect(c.start(CASE)).rejects.toThrow('Abre el portal');
  });

  it('envío bloqueado: registra el aviso y detiene la ejecución', async () => {
    const { c, events, trigger } = setup({ hang: true });
    await c.openPortal();
    const p = c.start(CASE);
    await new Promise((r) => setTimeout(r, 20));
    trigger();
    await p;
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', text: 'Intento de envío bloqueado' }));
    expect(c.isRunning).toBe(false);
  });

  it('valida los límites', async () => {
    const { c, calls } = setup();
    await c.openPortal();
    expect(() => c.setBounds({ x: 0, y: 0, width: -1, height: 5 })).toThrow();
    expect(() => c.setBounds({ x: 0, y: 0, width: NaN, height: 5 })).toThrow();
    expect(() => c.setBounds({ x: 0, y: 0, width: '5', height: 5 })).toThrow();
    expect(() => c.setBounds(null)).toThrow();
    c.setBounds({ x: 1.4, y: 2, width: 300, height: 200 });
    expect(calls).toContain('bounds:300');
  });

  it('dispose detiene todo, destruye la vista y apaga llama', async () => {
    const { c, calls } = setup();
    await c.openPortal();
    await c.dispose();
    expect(calls).toContain('destroy');
    expect(calls).toContain('llama-stop');
  });

  it('registerAgentIpc enruta y limpia', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const removed: string[] = [];
    const { c, calls } = setup();
    const off = registerAgentIpc(
      {
        handle: (ch, l) => void handlers.set(ch, l),
        on: (ch, l) => void handlers.set(ch, l),
        removeHandler: (ch) => void removed.push(ch),
        removeAllListeners: (ch) => void removed.push(ch),
      },
      c,
    );
    await handlers.get('agent:open')!({});
    handlers.get('agent:bounds')!({}, { x: 'mal' }); // no lanza
    handlers.get('agent:visible')!({}, 'sí'); // no lanza
    handlers.get('agent:visible')!({}, true);
    expect(calls.filter((x) => x.startsWith('visible:')).at(-1)).toBe('visible:true');
    await handlers.get('agent:stop')!({});
    off();
    expect(removed).toHaveLength(6);
  });

  it('stop durante el arranque del modelo termina la ejecución como detenida', async () => {
    let rej!: (e: Error) => void;
    const { c, events } = setup({ llamaStart: () => new Promise<string>((_r, j) => (rej = j)) });
    await c.openPortal();
    const p = c.start(CASE);
    c.stop();
    rej(new Error('Arranque del modelo cancelado.'));
    await p;
    expect(events).toContainEqual({ type: 'state', state: 'detenido' });
    expect(events.some((e) => e.type === 'model' && e.status === 'error')).toBe(false);
    expect(c.isRunning).toBe(false);
  });

  it('dispose durante el arranque resuelve sin esperar al modelo', async () => {
    let rej!: (e: Error) => void;
    const { c, calls } = setup({ llamaStart: () => new Promise<string>((_r, j) => (rej = j)) });
    await c.openPortal();
    const p = c.start(CASE).catch(() => {});
    const t0 = Date.now();
    // llama.stop() cancela el arranque pendiente, como hace LlamaServer.
    const dispose = c.dispose();
    rej(new Error('Arranque del modelo cancelado.'));
    await Promise.all([dispose, p]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(calls.indexOf('llama-stop')).toBeGreaterThan(-1);
    expect(calls).toContain('destroy');
  });

  it('blockedSubmits es por ejecución', async () => {
    let n = 5;
    const { c, events } = setup({ blocked: () => n, hang: true });
    await c.openPortal();
    await c.start(CASE);
    n = 7;
    const second = c.start(CASE);
    await new Promise((r) => setTimeout(r, 20));
    n = 9;
    await second;
    const fin = events.filter((e) => e.type === 'finished') as { blockedSubmits: number }[];
    expect(fin.map((f) => f.blockedSubmits)).toEqual([0, 2]);
  });

  it('visibilidad: valida el booleano, oculta por defecto y se aplica al abrir', async () => {
    const { c, calls } = setup();
    expect(() => c.setVisible('true')).toThrow();
    expect(() => c.setVisible(1)).toThrow();
    c.setVisible(true);
    await c.openPortal();
    expect(calls).toContain('visible:true');
    c.setVisible(false);
    expect(calls.at(-1)).toBe('visible:false');
    // Ocultar no toca los límites: la vista conserva su tamaño real.
    expect(calls.filter((x) => x === 'bounds:0')).toHaveLength(1); // solo el inicial al crear la vista
  });

  it('la vista empieza oculta si el renderer aún no dijo que es visible', async () => {
    const { c, calls } = setup();
    await c.openPortal();
    expect(calls).toContain('visible:false');
    expect(calls).not.toContain('visible:true');
  });

  it('cada ejecución recarga el portal antes de adjuntar el depurador', async () => {
    const { c, calls } = setup();
    await c.openPortal();
    await c.start(CASE);
    await c.start(CASE);
    const loads = calls.reduce<number[]>((a, x, i) => (x === 'load' ? [...a, i] : a), []);
    const attaches = calls.reduce<number[]>((a, x, i) => (x === 'attach' ? [...a, i] : a), []);
    expect(loads).toHaveLength(3); // abrir + 2 ejecuciones
    expect(loads[1]!).toBeLessThan(attaches[0]!);
    expect(loads[2]!).toBeGreaterThan(attaches[0]!);
    expect(loads[2]!).toBeLessThan(attaches[1]!);
    expect(calls.indexOf('load', loads[1]!)).toBeLessThan(calls.indexOf('active:true'));
  });

  it('envío bloqueado durante attach: la ejecución termina detenida sin observar', async () => {
    let trigger!: () => void;
    // La página intenta enviar mientras attach() aún no ha terminado (todavía no hay orquestador).
    const s = setup({ attach: async () => trigger() });
    trigger = () => s.trigger();
    await s.c.openPortal();
    await s.c.start(CASE);
    expect(s.events).toContainEqual(expect.objectContaining({ type: 'log', text: 'Intento de envío bloqueado' }));
    expect(s.events).toContainEqual({ type: 'state', state: 'detenido' });
    expect(s.events.some((e) => e.type === 'state' && e.state === 'entregado')).toBe(false);
    expect(s.calls).not.toContain('observe');
  });

  it('un fallo al leer la declaración es un error del agente, no del modelo', async () => {
    const { c, events, calls } = setup({
      loadDeclaration: () => {
        throw new Error('No se pudo leer la declaración: JSON roto');
      },
    });
    await c.openPortal();
    await expect(c.start(CASE)).rejects.toThrow('No se pudo leer la declaración: JSON roto');
    expect(events).toContainEqual({ type: 'state', state: 'error', message: 'No se pudo leer la declaración: JSON roto' });
    expect(events.some((e) => e.type === 'model')).toBe(false);
    expect(calls).not.toContain('attach');
    expect(c.isRunning).toBe(false);
  });
  it('arranca con aprobación vigente y emite declaration antes de model', async () => {
    const { c, events } = setup();
    await c.openPortal();
    await c.start(CASE);
    const kinds = events.map((e) => e.type);
    expect(events).toContainEqual({ type: 'declaration', ...APPROVAL });
    expect(kinds.indexOf('declaration')).toBeLessThan(kinds.indexOf('model'));
  });

  it.each([
    ['no_approval', 'No hay ninguna versión aprobada del expediente. Revísalo y apruébalo antes de rellenar el portal.'],
    ['approval_stale', 'El expediente cambió después de la aprobación. Vuelve a aprobarlo.'],
    ['approval_corrupt', 'La versión aprobada no supera la comprobación de integridad.'],
    ['not_found', 'No hay ninguna versión aprobada del expediente. Revísalo y apruébalo antes de rellenar el portal.'],
  ] as const)('%s: no arranca, estado error con el texto exacto, sin llama ni attach', async (code, text) => {
    let llamaStarted = false;
    const { c, events, calls } = setup({
      llamaStart: async () => {
        llamaStarted = true;
        return 'http://127.0.0.1:1';
      },
      loadDeclaration: () => {
        throw new ExpedienteError(code, 'mensaje interno que no debe llegar al usuario');
      },
    });
    await c.openPortal();
    await expect(c.start(CASE)).rejects.toThrow(text);
    expect(events).toContainEqual({ type: 'state', state: 'error', message: text });
    expect(events.some((e) => e.type === 'model' || e.type === 'declaration')).toBe(false);
    expect(llamaStarted).toBe(false);
    expect(calls).not.toContain('attach');
    expect(c.isRunning).toBe(false);
  });

  it('onCaseChanged del mismo expediente detiene la ejecución con el log exacto; otro expediente no', async () => {
    const other = setup({ hang: true });
    await other.c.openPortal();
    const p0 = other.c.start(CASE);
    await new Promise((r) => setTimeout(r, 20));
    other.c.onCaseChanged('00000000-0000-4000-8000-000000000000');
    await p0;
    expect(other.events.some((e) => e.type === 'log' && e.text.startsWith('El expediente cambió'))).toBe(false);
    expect(other.events).not.toContainEqual({ type: 'state', state: 'detenido' });

    const { c, events } = setup({ hang: true });
    await c.openPortal();
    const p = c.start(CASE);
    await new Promise((r) => setTimeout(r, 20));
    c.onCaseChanged(CASE);
    await p;
    expect(events).toContainEqual(expect.objectContaining({ type: 'log', text: 'El expediente cambió: llenado detenido' }));
    expect(events).toContainEqual({ type: 'state', state: 'detenido' });
    expect(c.isRunning).toBe(false);
    // Sin ejecución en curso no hace nada.
    const n = events.length;
    c.onCaseChanged(CASE);
    expect(events).toHaveLength(n);
  });

  it('agent:start con caseId no válido rechaza sin llamar a loadDeclaration', async () => {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    let loaded = 0;
    const { c } = setup({
      loadDeclaration: () => {
        loaded++;
        return { declaration: {} };
      },
    });
    registerAgentIpc(
      { handle: (ch, l) => void handlers.set(ch, l), on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
      c,
    );
    await c.openPortal();
    for (const bad of [undefined, 'x', CASE.toUpperCase(), 5, `${CASE}0`]) {
      await expect(handlers.get('agent:start')!({}, bad)).rejects.toThrow(APPROVAL_MESSAGES.no_approval);
    }
    expect(loaded).toBe(0);
    await handlers.get('agent:start')!({}, CASE);
    expect(loaded).toBe(1);
  });
});
