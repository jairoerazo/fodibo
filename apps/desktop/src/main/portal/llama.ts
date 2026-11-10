// Gestiona el proceso `llama-server` local (solo 127.0.0.1). Un único proceso reutilizable entre ejecuciones.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

export const MSG_NO_BINARY = 'No se encontró llama-server. Instálalo con «brew install llama.cpp» o define FODIBO_LLAMA_SERVER.';
export const MSG_NO_MODEL = 'No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.';

export interface LlamaServerOptions {
  binary: string;
  modelPath: string;
  /** Argumentos antepuestos a los propios (permite lanzar un script con `process.execPath` en las pruebas). */
  args?: string[];
  spawn?: typeof nodeSpawn;
  healthTimeoutMs?: number;
  killTimeoutMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export class LlamaServer {
  private child?: ChildProcess;
  private starting?: Promise<string>;
  private baseUrl?: string;
  private stopping = false;
  /** Se incrementa en cada `stop()`: invalida los arranques en curso. */
  private gen = 0;
  private readonly onExit = (): void => {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // mejor esfuerzo
    }
  };

  constructor(private readonly opts: LlamaServerOptions) {}

  start(): Promise<string> {
    if (this.baseUrl && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return Promise.resolve(this.baseUrl);
    }
    this.starting ??= this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async doStart(): Promise<string> {
    const { binary, modelPath } = this.opts;
    if (!existsSync(modelPath)) throw new Error(MSG_NO_MODEL);
    this.stopping = false;
    const gen = this.gen;
    const port = await freePort();
    if (gen !== this.gen) throw new Error('Arranque del modelo cancelado.');
    const baseUrl = `http://127.0.0.1:${port}`;
    const spawn = this.opts.spawn ?? nodeSpawn;
    const args = [...(this.opts.args ?? []), '-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '--temp', '0'];

    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw this.spawnError(err);
    }
    this.child = child;
    process.on('exit', this.onExit);

    let stderrTail = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString('utf8')).slice(-2000);
    });

    let failure: Error | undefined;
    let exited = false;
    child.once('error', (err) => {
      failure = this.spawnError(err);
      exited = true;
    });
    child.once('exit', (code, signal) => {
      exited = true;
      process.removeListener('exit', this.onExit);
      if (this.child === child) {
        this.child = undefined;
        this.baseUrl = undefined;
      }
      if (!failure) {
        if (this.stopping) failure = new Error('Arranque del modelo cancelado.');
        else {
          const lines = stderrTail.trim().split('\n').slice(-10).join('\n');
          failure = new Error(
            `llama-server terminó antes de estar listo (${signal ?? `código ${String(code)}`}).${lines ? `\n${lines}` : ''}`,
          );
        }
      }
    });

    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 120000);
    while (!exited) {
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('Tiempo de espera agotado al arrancar llama-server.');
      }
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) {
          if (exited) break;
          this.baseUrl = baseUrl;
          return baseUrl;
        }
      } catch {
        // aún no escucha
      }
      await sleep(100);
    }
    // El 'exit' puede llegar un instante después de 'error'.
    await sleep(0);
    throw failure ?? new Error('llama-server terminó antes de estar listo.');
  }

  private spawnError(err: unknown): Error {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return new Error(MSG_NO_BINARY);
    return new Error(`No se pudo lanzar llama-server: ${err instanceof Error ? err.message : String(err)}`);
  }

  async stop(): Promise<void> {
    this.gen++;
    const child = this.child;
    this.baseUrl = undefined;
    if (!child) return;
    this.stopping = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ya terminó
        }
      }, this.opts.killTimeoutMs ?? 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    if (this.child === child) this.child = undefined;
    process.removeListener('exit', this.onExit);
  }
}
