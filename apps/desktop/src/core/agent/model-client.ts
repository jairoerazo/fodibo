import { TopLevelMembers } from './json-stream.js';

export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
  }
}

export type ChatMessage = { role: 'system' | 'user'; content: string };

/** Recibe cada miembro de primer nivel de la respuesta (un campo del paso) en cuanto el modelo lo cierra. */
export type OnField = (fieldId: string, value: unknown) => void;

export interface ModelClient {
  /**
   * Devuelve el objeto JSON completo de la respuesta. Con `onField`, la respuesta se lee en streaming y
   * cada campo se notifica antes de que termine; el valor devuelto sigue siendo la respuesta entera.
   */
  complete(messages: ChatMessage[], schema: object, signal: AbortSignal, onField?: OnField): Promise<unknown>;
}

export function createLlamaClient(baseUrl: string, opts: { timeoutMs?: number } = {}): ModelClient {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  return {
    async complete(messages, schema, signal, onField) {
      // Sin streaming, el plazo es para la respuesta entera; en streaming, cuenta desde el último dato
      // recibido: una respuesta lenta que sigue avanzando no se corta.
      const idle = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), timeoutMs);
      };
      touch();
      const combined = AbortSignal.any([signal, idle.signal]);
      let res: Response;
      let content: string | undefined;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages,
            temperature: 0,
            response_format: { type: 'json_schema', json_schema: { name: 'paso', schema, strict: true } },
            // Modelos híbridos (p. ej. Qwen3 1.7B): sin fase de razonamiento; el resto de plantillas lo ignora.
            chat_template_kwargs: { enable_thinking: false },
            ...(onField ? { stream: true } : {}),
          }),
          signal: combined,
        });
        if (res.ok) content = onField ? await readStream(res, onField, touch) : await readBody(res);
      } catch (e) {
        if (e instanceof ModelError) throw e;
        const why = signal.aborted ? 'petición cancelada' : idle.signal.aborted ? 'tiempo de espera agotado' : 'no se pudo contactar con el modelo';
        throw new ModelError(why, { cause: e });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new ModelError(`El modelo respondió HTTP ${res.status}`);
      try {
        return JSON.parse(content ?? '') as unknown;
      } catch (e) {
        throw new ModelError('Respuesta del modelo no válida', { cause: e });
      }
    },
  };
}

async function readBody(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('sin contenido');
    return content;
  } catch (e) {
    throw new ModelError('Respuesta del modelo no válida', { cause: e });
  }
}

/** Lee eventos SSE (`data: {...}`) de `llama-server`, acumula el contenido y notifica cada campo cerrado. */
async function readStream(res: Response, onField: OnField, onData: () => void): Promise<string> {
  if (!res.body) throw new ModelError('Respuesta del modelo sin cuerpo');
  const members = new TopLevelMembers();
  const decoder = new TextDecoder();
  let pending = '';
  let content = '';
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') return;
    let piece: unknown;
    try {
      piece = (JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
    } catch (e) {
      throw new ModelError('Respuesta del modelo no válida', { cause: e });
    }
    if (typeof piece !== 'string' || piece === '') return;
    content += piece;
    for (const [id, value] of members.push(piece)) {
      try {
        onField(id, value);
      } catch {
        // un receptor defectuoso no debe cortar la lectura
      }
    }
  };
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    onData();
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop()!;
    lines.forEach(handle);
  }
  pending += decoder.decode();
  if (pending) handle(pending);
  return content;
}
