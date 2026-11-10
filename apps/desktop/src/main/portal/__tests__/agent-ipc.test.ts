import { describe, expect, it } from 'vitest';
import type { AgentUiEvent } from '../../../shared/agent-ipc.js';
import { AgentController, createLlamaFromEnv, registerAgentIpc, type AdapterLike, type ViewLike } from '../agent-ipc.js';

function setup(opts: { llamaStart?: () => Promise<string>; modelComplete?: () => Promise<unknown>; hang?: boolean } = {}) {
  const calls: string[] = [];
  const events: AgentUiEvent[] = [];
  let blockedCb: (() => void) | undefined;
  const view: ViewLike = {
    load: async () => void calls.push('load'),
    setBounds: (r) => void calls.push(`bounds:${r.width}`),
    setAgentActive: (a) => void calls.push(`active:${a}`),
    blockedSubmits: 0,
    onSubmitBlocked: (cb) => void (blockedCb = cb),
    destroy: () => void calls.push('destroy'),
  };
  const adapter: AdapterLike = {
    attach: async () => void calls.push('attach'),
    detach: () => void calls.push('detach'),
    observarPaso: async () => {
      if (opts.hang) await new Promise((r) => setTimeout(r, 200));
      return { index: 1, total: 1, title: 't', isSummary: true, fields: [], errors: [] };
    },
    rellenarCampo: async () => {},
    leerCampo: async () => '',
    avanzarPaso: async () => {},
  };
  const llama = {
    start: opts.llamaStart ?? (async () => 'http://127.0.0.1:1'),
    stop: async () => void calls.push('llama-stop'),
  };
  const c = new AgentController({
    createView: () => ({ view, adapter }),
    getLlama: () => llama,
    createModel: () => ({ complete: opts.modelComplete ?? (async () => ({})) }),
    loadDeclaration: () => ({}),
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
    await expect(c.start()).rejects.toThrow('No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.');
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
    await c.start();
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
    const first = c.start();
    await expect(c.start()).rejects.toThrow('Ya hay una ejecución en curso.');
    release('http://127.0.0.1:1');
    await first;
  });

  it('start sin portal abierto: error legible', async () => {
    const { c } = setup();
    await expect(c.start()).rejects.toThrow('Abre el portal');
  });

  it('envío bloqueado: registra el aviso y detiene la ejecución', async () => {
    const { c, events, trigger } = setup({ hang: true });
    await c.openPortal();
    const p = c.start();
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
    const { c } = setup();
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
    await handlers.get('agent:stop')!({});
    off();
    expect(removed).toHaveLength(5);
  });
});
