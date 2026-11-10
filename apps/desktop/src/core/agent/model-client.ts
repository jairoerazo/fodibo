export class ModelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
  }
}

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface ModelClient {
  complete(messages: ChatMessage[], schema: object, signal: AbortSignal): Promise<unknown>;
}

export function createLlamaClient(baseUrl: string, opts: { timeoutMs?: number } = {}): ModelClient {
  const timeoutMs = opts.timeoutMs ?? 180000;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  return {
    async complete(messages, schema, signal) {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages,
            temperature: 0,
            response_format: { type: 'json_schema', json_schema: { name: 'paso', schema, strict: true } },
          }),
          signal: combined,
        });
        text = await res.text();
      } catch (e) {
        const why = signal.aborted ? 'petición cancelada' : combined.aborted ? 'tiempo de espera agotado' : 'no se pudo contactar con el modelo';
        throw new ModelError(why, { cause: e });
      }
      if (!res.ok) throw new ModelError(`El modelo respondió HTTP ${res.status}`);
      try {
        const body = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('sin contenido');
        return JSON.parse(content) as unknown;
      } catch (e) {
        throw new ModelError('Respuesta del modelo no válida', { cause: e });
      }
    },
  };
}
