// Controlador del agente en el proceso principal. No importa `electron` en tiempo de ejecución
// (recibe `ipcMain` y las fábricas por inyección) para poder probarse en Node.
import { AgentOrchestrator, createLlamaClient } from '../../core/agent/index.js';
import type { AgentEvent, Declaration, ModelClient, PortalAdapter } from '../../core/agent/index.js';
import { AGENT_CHANNELS, type AgentBounds, type AgentUiEvent } from '../../shared/agent-ipc.js';
import { LlamaServer, MSG_NO_MODEL } from './llama.js';

export interface ViewLike {
  load(): Promise<void>;
  setBounds(r: AgentBounds): void;
  setAgentActive(active: boolean): void;
  readonly blockedSubmits: number;
  onSubmitBlocked(cb: () => void): void;
  destroy(): void;
}
export interface AdapterLike extends PortalAdapter {
  attach(): Promise<void>;
  detach(): void;
}
export interface LlamaLike {
  start(): Promise<string>;
  stop(): Promise<void>;
}

export interface AgentDeps {
  /** Crea la vista del portal; `undefined` si no hay ventana. */
  createView(): { view: ViewLike; adapter: AdapterLike } | undefined;
  getLlama(): LlamaLike;
  createModel?: (baseUrl: string) => ModelClient;
  loadDeclaration(): Declaration;
  emit(e: AgentUiEvent): void;
}

const ZERO: AgentBounds = { x: 0, y: 0, width: 0, height: 0 };

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentController {
  private current?: { view: ViewLike; adapter: AdapterLike };
  private lastBounds: AgentBounds = ZERO;
  private orchestrator?: AgentOrchestrator;
  private running?: Promise<void>;
  private stopRequested = false;
  private startingModel = false;

  constructor(private readonly deps: AgentDeps) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  async openPortal(): Promise<void> {
    if (this.current) return;
    const made = this.deps.createView();
    if (!made) throw new Error('No hay ventana disponible.');
    this.current = made;
    made.view.setBounds(this.lastBounds);
    made.view.onSubmitBlocked(() => {
      if (!this.orchestrator) return;
      this.deps.emit({ type: 'log', at: new Date().toISOString(), text: 'Intento de envío bloqueado' });
      this.orchestrator.stop();
    });
    try {
      await made.view.load();
    } catch (err) {
      if (this.current === made) this.destroyView();
      throw new Error(`No se pudo abrir el portal: ${errMsg(err)}`);
    }
  }

  async closePortal(): Promise<void> {
    this.stop();
    await this.running;
    this.destroyView();
  }

  private destroyView(): void {
    const cur = this.current;
    this.current = undefined;
    cur?.view.destroy();
  }

  setBounds(r: unknown): void {
    if (typeof r !== 'object' || r === null) throw new Error('Límites no válidos');
    const b = r as Record<string, unknown>;
    const out: number[] = [];
    for (const k of ['x', 'y', 'width', 'height']) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Límites no válidos');
      out.push(Math.round(v));
    }
    this.lastBounds = { x: out[0]!, y: out[1]!, width: out[2]!, height: out[3]! };
    this.current?.view.setBounds(this.lastBounds);
  }

  stop(): void {
    this.stopRequested = true;
    this.orchestrator?.stop();
    // Durante el arranque del modelo aún no hay orquestador: se cancela la espera de salud.
    if (this.startingModel) void this.deps.getLlama().stop().catch(() => {});
  }

  /** Resuelve cuando termina la ejecución. Rechaza con un mensaje legible si no pudo empezar. */
  start(): Promise<void> {
    if (this.running) return Promise.reject(new Error('Ya hay una ejecución en curso.'));
    if (!this.current) return Promise.reject(new Error('Abre el portal antes de iniciar el agente.'));
    this.stopRequested = false;
    const p = this.execute(this.current).finally(() => {
      this.running = undefined;
      this.orchestrator = undefined;
    });
    this.running = p.catch(() => {});
    return p;
  }

  private async execute(cur: { view: ViewLike; adapter: AdapterLike }): Promise<void> {
    const { emit } = this.deps;
    emit({ type: 'model', status: 'arrancando' });
    let baseUrl: string;
    let declaration: Declaration;
    try {
      declaration = this.deps.loadDeclaration();
      this.startingModel = true;
      baseUrl = await this.deps.getLlama().start();
    } catch (err) {
      if (this.stopRequested) {
        emit({ type: 'state', state: 'detenido' });
        return;
      }
      const message = errMsg(err);
      emit({ type: 'model', status: 'error', message });
      throw new Error(message);
    } finally {
      this.startingModel = false;
    }
    if (this.stopRequested) {
      emit({ type: 'state', state: 'detenido' });
      return;
    }
    emit({ type: 'model', status: 'listo' });

    // Los eventos finales se retienen hasta entregar el control (detach → setAgentActive(false)).
    const baseline = cur.view.blockedSubmits;
    const held: AgentEvent[] = [];
    const onEvent = (e: AgentEvent): void => {
      const terminal = e.type === 'finished' || (e.type === 'state' && ['entregado', 'detenido', 'error'].includes(e.state));
      if (terminal) held.push(e);
      else emit(e);
    };

    try {
      cur.view.setAgentActive(true);
      await cur.adapter.attach();
      const orchestrator = new AgentOrchestrator({
        adapter: cur.adapter,
        model: (this.deps.createModel ?? ((u: string) => createLlamaClient(u)))(baseUrl),
        declaration,
        onEvent,
        getBlockedSubmits: () => cur.view.blockedSubmits - baseline,
      });
      this.orchestrator = orchestrator;
      if (this.stopRequested) orchestrator.stop();
      await orchestrator.run();
    } catch (err) {
      held.push({ type: 'state', state: 'error', message: errMsg(err) });
    } finally {
      try {
        cur.adapter.detach();
      } catch {
        // ya desconectado
      }
      cur.view.setAgentActive(false);
      for (const e of held) emit(e);
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    // Primero se apaga el modelo: así un arranque pendiente termina de inmediato.
    await this.deps.getLlama().stop();
    await this.running;
    this.destroyView();
    await this.deps.getLlama().stop();
  }
}

interface IpcMainLike {
  handle(channel: string, listener: (e: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (e: unknown, ...args: unknown[]) => void): void;
  removeHandler(channel: string): void;
  removeAllListeners(channel: string): void;
}

export function registerAgentIpc(ipc: IpcMainLike, controller: AgentController): () => void {
  ipc.handle(AGENT_CHANNELS.open, () => controller.openPortal());
  ipc.handle(AGENT_CHANNELS.close, () => controller.closePortal());
  ipc.handle(AGENT_CHANNELS.start, () => controller.start());
  ipc.handle(AGENT_CHANNELS.stop, () => controller.stop());
  ipc.on(AGENT_CHANNELS.bounds, (_e, r) => {
    try {
      controller.setBounds(r);
    } catch {
      // límites no válidos: se ignoran
    }
  });
  return () => {
    for (const ch of [AGENT_CHANNELS.open, AGENT_CHANNELS.close, AGENT_CHANNELS.start, AGENT_CHANNELS.stop]) ipc.removeHandler(ch);
    ipc.removeAllListeners(AGENT_CHANNELS.bounds);
  };
}

/** Configuración de `llama-server` desde el entorno; el modelo es obligatorio (se comprueba al iniciar). */
export function createLlamaFromEnv(env: NodeJS.ProcessEnv = process.env): LlamaLike {
  const modelPath = env['FODIBO_MODEL'];
  if (!modelPath) {
    return {
      start: () => Promise.reject(new Error(MSG_NO_MODEL)),
      stop: () => Promise.resolve(),
    };
  }
  return new LlamaServer({ binary: env['FODIBO_LLAMA_SERVER'] || 'llama-server', modelPath });
}
