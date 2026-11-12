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
    expect(seen.chat_template_kwargs).toEqual({ enable_thinking: false });
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
  it('con onField pide stream y avisa de cada campo según llega; devuelve el objeto completo', async () => {
    let seen: any;
    const parts = ['{"c1": {"sou', 'rce": "x"}', ', "c2": {"skip"', ': true}}'];
    const got: [string, unknown][] = [];
    const url = await start((b, res) => {
      seen = b;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Un evento partido entre dos escrituras y otro con el rol, sin contenido.
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      const ev = parts.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('');
      res.write(ev.slice(0, 25));
      setTimeout(() => {
        expect(got).toEqual([]);
        res.end(ev.slice(25) + 'data: [DONE]\n\n');
      }, 20);
    });
    const out = await createLlamaClient(url).complete(msgs, schema, new AbortController().signal, (id, v) => got.push([id, v]));
    expect(seen.stream).toBe(true);
    expect(got).toEqual([
      ['c1', { source: 'x' }],
      ['c2', { skip: true }],
    ]);
    expect(out).toEqual({ c1: { source: 'x' }, c2: { skip: true } });
  });
  it('stream con contenido incompleto -> ModelError', async () => {
    const url = await start((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a": {' } }] })}\n\ndata: [DONE]\n\n`);
    });
    await expect(createLlamaClient(url).complete(msgs, schema, new AbortController().signal, () => {})).rejects.toBeInstanceOf(ModelError);
  });
  it('un fallo del receptor onField no rompe la lectura', async () => {
    const url = await start((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a": 1}' } }] })}\n\ndata: [DONE]\n\n`);
    });
    const out = await createLlamaClient(url).complete(msgs, schema, new AbortController().signal, () => { throw new Error('x'); });
    expect(out).toEqual({ a: 1 });
  });
  it('sin onField no pide stream', async () => {
    let seen: any;
    const url = await start((b, res) => { seen = b; reply(res, '{}'); });
    await createLlamaClient(url).complete(msgs, schema, new AbortController().signal);
    expect(seen.stream).toBeUndefined();
  });
  it('en streaming el plazo cuenta desde el último dato recibido, no desde el inicio', async () => {
    const url = await start((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pieces = ['{"a"', ': 1', ', "b"', ': 2', '}'];
      let i = 0;
      const t = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
        if (++i === pieces.length) {
          clearInterval(t);
          res.end('data: [DONE]\n\n');
        }
      }, 60);
    });
    const out = await createLlamaClient(url, { timeoutMs: 150 }).complete(msgs, schema, new AbortController().signal, () => {});
    expect(out).toEqual({ a: 1, b: 2 });
  });
  it('en streaming, un silencio más largo que el plazo -> ModelError', async () => {
    const url = await start((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"a"' } }] })}\n\n`);
    });
    await expect(createLlamaClient(url, { timeoutMs: 100 }).complete(msgs, schema, new AbortController().signal, () => {})).rejects.toThrow('tiempo de espera agotado');
  });
  it('conexión rechazada -> ModelError', async () => {
    await expect(createLlamaClient('http://127.0.0.1:1').complete(msgs, schema, new AbortController().signal)).rejects.toBeInstanceOf(ModelError);
  });
});
