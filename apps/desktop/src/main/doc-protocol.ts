// Protocolo `fodibo-doc:` — sirve los originales del expediente al visor. No importa `electron` en tiempo de
// ejecución (solo el tipo `Session`), así que `serveDocument` se prueba en Node. Nunca incluye rutas ni nombres
// de archivo en respuestas o registros: solo el identificador del documento llega al servicio.
import { Readable } from 'node:stream';
import type { Session } from 'electron';
import { ExpedienteError, type ExpedienteService } from '../core/expediente/index.js';

export const DOC_SCHEME = 'fodibo-doc';

export type DocServer = Pick<ExpedienteService, 'openDocument'>;

const URL_RE = /^fodibo-doc:\/\/doc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } as const;
const empty = (status: number, extra: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { ...SECURITY_HEADERS, ...extra } });

/** Rango resuelto (extremos inclusivos), `'none'` si la cabecera no es un rango simple o `'unsatisfiable'`. */
function resolveRange(header: string | null, size: number): { start: number; end: number } | 'none' | 'unsatisfiable' {
  if (header === null) return 'none';
  const m = RANGE_RE.exec(header.trim());
  // Sintaxis no admitida (p. ej. varios rangos): se ignora y se sirve el documento entero (RFC 9110 §14.2).
  if (!m || (m[1] === '' && m[2] === '')) return 'none';
  const a = m[1] as string;
  const b = m[2] as string;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return 'none';
  }
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  return { start, end };
}

export async function serveDocument(svc: DocServer, url: string, rangeHeader: string | null): Promise<Response> {
  const m = URL_RE.exec(url);
  if (!m) return empty(404);
  try {
    const doc = await svc.openDocument(m[1] as string);
    const range = resolveRange(rangeHeader, doc.size);
    if (range === 'unsatisfiable') return empty(416, { 'Content-Range': `bytes */${doc.size}` });
    const base = { ...SECURITY_HEADERS, 'Content-Type': doc.mime, 'Accept-Ranges': 'bytes' };
    if (range === 'none') {
      const body = Readable.toWeb(await doc.open()) as unknown as ReadableStream;
      return new Response(body, { status: 200, headers: { ...base, 'Content-Length': String(doc.size) } });
    }
    const body = Readable.toWeb(await doc.open(range)) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        ...base,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${doc.size}`,
      },
    });
  } catch (err) {
    if (err instanceof ExpedienteError) {
      if (err.code === 'integrity_error') return empty(409);
      if (err.code === 'not_found' || err.code === 'invalid_input') return empty(404);
    }
    console.error('[fodibo] fodibo-doc: storage_error');
    return empty(500);
  }
}

export function registerDocProtocol(ses: Session, svc: DocServer): void {
  ses.protocol.handle(DOC_SCHEME, (req) => (req.method === 'GET' ? serveDocument(svc, req.url, req.headers.get('range')) : empty(405)));
}
