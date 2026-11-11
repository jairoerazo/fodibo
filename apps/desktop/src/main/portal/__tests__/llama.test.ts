import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LlamaServer } from '../llama.js';

const dir = mkdtempSync(join(tmpdir(), 'fodibo-llama-'));
const model = join(dir, 'm.gguf');
const okScript = join(dir, 'ok.mjs');
const dieScript = join(dir, 'die.mjs');
let pidFile = join(dir, 'pid');

beforeAll(() => {
  writeFileSync(model, 'x');
  writeFileSync(
    okScript,
    `import http from 'node:http'; import { writeFileSync } from 'node:fs';
const a = process.argv; const port = Number(a[a.indexOf('--port') + 1]);
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, args: a.slice(2) }));
http.createServer((q, r) => { r.statusCode = q.url === '/health' ? 200 : 404; r.end('ok'); }).listen(port, '127.0.0.1');`,
  );
  writeFileSync(dieScript, `console.error('línea1\\nfallo cargando modelo'); process.exit(3);`);
});

let server: LlamaServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('LlamaServer', () => {
  it('binario inexistente: mensaje exacto', async () => {
    server = new LlamaServer({ binary: join(dir, 'no-existe'), modelPath: model });
    await expect(server.start()).rejects.toThrow(
      'No se encontró llama-server. Instálalo con «brew install llama.cpp» o define FODIBO_LLAMA_SERVER.',
    );
  });

  it('modelo inexistente: mensaje exacto y sin lanzar proceso', async () => {
    let spawned = 0;
    server = new LlamaServer({
      binary: 'x',
      modelPath: join(dir, 'no.gguf'),
      spawn: (() => {
        spawned++;
        throw new Error('no debe lanzarse');
      }) as never,
    });
    await expect(server.start()).rejects.toThrow('No se encontró el modelo. Define FODIBO_MODEL con la ruta al archivo .gguf.');
    expect(spawned).toBe(0);
  });

  it('ejecutable falso sano: devuelve la URL y usa los argumentos acordados', async () => {
    server = new LlamaServer({ binary: process.execPath, args: [okScript], modelPath: model });
    const url = await server.start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = url.split(':')[2];
    const info = JSON.parse((await import('node:fs')).readFileSync(pidFile, 'utf8')) as { args: string[] };
    expect(info.args).toEqual(['-m', model, '--host', '127.0.0.1', '--port', port, '-c', '8192', '--temp', '0']);
    expect(await server.start()).toBe(url); // reutilizado
  });

  it('extraArgs se añaden al final y pid expone el proceso', async () => {
    server = new LlamaServer({ binary: process.execPath, args: [okScript], modelPath: model, extraArgs: ['-t', '4'] });
    expect(server.pid).toBeUndefined();
    const url = await server.start();
    const port = url.split(':')[2];
    const info = JSON.parse((await import('node:fs')).readFileSync(pidFile, 'utf8')) as { pid: number; args: string[] };
    expect(info.args).toEqual(['-m', model, '--host', '127.0.0.1', '--port', port, '-c', '8192', '--temp', '0', '-t', '4']);
    expect(server.pid).toBe(info.pid);
    await server.stop();
    expect(server.pid).toBeUndefined();
  });

  it('el proceso muere antes de estar sano: error con su stderr', async () => {
    server = new LlamaServer({ binary: process.execPath, args: [dieScript], modelPath: model });
    await expect(server.start()).rejects.toThrow(/fallo cargando modelo/);
  });

  it('tiempo de espera de salud agotado', async () => {
    const sleeper = join(dir, 'sleep.mjs');
    writeFileSync(sleeper, 'setInterval(() => {}, 1000);');
    server = new LlamaServer({ binary: process.execPath, args: [sleeper], modelPath: model, healthTimeoutMs: 600 });
    await expect(server.start()).rejects.toThrow(/tiempo/i);
  });

  it('stop() termina el proceso', async () => {
    server = new LlamaServer({ binary: process.execPath, args: [okScript], modelPath: model });
    await server.start();
    const { pid } = JSON.parse((await import('node:fs')).readFileSync(pidFile, 'utf8')) as { pid: number };
    expect(alive(pid)).toBe(true);
    await server.stop();
    expect(alive(pid)).toBe(false);
    await server.stop(); // idempotente
  });

  it('stop() durante el arranque cancela de inmediato y no deja proceso', async () => {
    const sleeper = join(dir, 'sleep2.mjs');
    writeFileSync(
      sleeper,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000);`,
    );
    server = new LlamaServer({ binary: process.execPath, args: [sleeper], modelPath: model, healthTimeoutMs: 60000 });
    const t0 = Date.now();
    const p = server.start();
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
    await server.stop();
    await expect(p).rejects.toThrow(/cancelado/);
    expect(Date.now() - t0).toBeLessThan(10000);
    const { pid } = JSON.parse((await import('node:fs')).readFileSync(pidFile, 'utf8')) as { pid: number };
    expect(alive(pid)).toBe(false);
  });

  it('stop() inmediatamente tras start() (antes de lanzar) no lanza el proceso', async () => {
    let spawned = 0;
    server = new LlamaServer({
      binary: 'x',
      modelPath: model,
      spawn: (() => {
        spawned++;
        throw new Error('no debe lanzarse');
      }) as never,
    });
    const p = server.start();
    p.catch(() => {});
    await server.stop();
    await expect(p).rejects.toThrow(/cancelado/);
    expect(spawned).toBe(0);
  });
});
