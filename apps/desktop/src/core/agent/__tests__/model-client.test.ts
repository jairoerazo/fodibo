import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlamaClient, ModelError } from '../model-client.js';

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(handler: (body: any, res: import('node:http').ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      req.url === '/v1/chat/completions' && req.method === 'POST' ? handler(JSON.parse(raw), res) : res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}
const reply = (res: import('node:http').ServerResponse, content: string) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
const msgs = [{ role: 'user' as const, content: 'hola' }];
const schema = { type: 'object' };

describe('createLlamaClient', () => {
  it('envía temperature 0 y el schema, y devuelve el JSON del contenido', async () => {
    let seen: any;
    const url = await start((b, res) => { seen = b; reply(res, '{"a":1}'); });
    const out = await createLlamaClient(url).complete(msgs, schema, new AbortController().signal);
    expect(out).toEqual({ a: 1 });
    expect(seen.temperature).toBe(0);
    expect(seen.messages).toEqual(msgs);
    expect(seen.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'paso', schema, strict: true } });
  });
  it('HTTP 500 -> ModelError', async () => {
    const url = await start((_b, res) => res.writeHead(500).end('boom'));
    await expect(createLlamaClient(url).complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
  it('contenido no JSON -> ModelError', async () => {
    const url = await start((_b, res) => reply(res, 'no json'));
    await expect(createLlamaClient(url).complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
  it('cuerpo sin choices -> ModelError', async () => {
    const url = await start((_b, res) => res.writeHead(200).end('{}'));
    await expect(createLlamaClient(url).complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
  it('abort rechaza sin esperar al timeout', async () => {
    const url = await start(() => { /* nunca responde */ });
    const ac = new AbortController();
    const p = createLlamaClient(url, { timeoutMs: 60000 }).complete(msgs, schema, ac.signal);
    setTimeout(() => ac.abort(), 30);
    const t = Date.now();
    await expect(p).rejects.toBeInstanceOf(ModelError);
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('timeout -> ModelError', async () => {
    const url = await start(() => { /* nunca responde */ });
    await expect(createLlamaClient(url, { timeoutMs: 50 }).complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
  it('conexión rechazada -> ModelError', async () => {
    await expect(createLlamaClient('http://127.0.0.1:1').complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
});
