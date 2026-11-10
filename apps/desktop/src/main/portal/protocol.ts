// Esquema `fodibo-portal:` y sesión aislada del portal de prueba.
// La sesión es temporal (sin `persist:`), sirve solo archivos de `rootDir`, cancela cualquier
// petición de otro esquema y deniega todos los permisos.
import { protocol, session as electronSession, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export const PORTAL_SCHEME = 'fodibo-portal';
export const PORTAL_HOST = 'portal';
export const PORTAL_START_URL = `${PORTAL_SCHEME}://${PORTAL_HOST}/index.html`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Raíz del portal en la build: `out/test-portal`, junto a `out/main`. */
export function portalRoot(): string {
  return resolve(import.meta.dirname, '../test-portal');
}

/** Debe llamarse antes de `app.ready`. */
export function registerPortalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PORTAL_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** Últimas peticiones canceladas por sesión (diagnóstico y self-test). */
const blocked = new WeakMap<Session, string[]>();
export function blockedRequests(ses: Session): readonly string[] {
  return blocked.get(ses) ?? [];
}

/** Únicos archivos que el portal puede pedir. Los datos de prueba (`*.json`) no se sirven. */
export const PORTAL_FILES: readonly string[] = ['index.html', 'portal.js', 'portal.css', 'enviado.html', 'enviado.js'];

/**
 * Normaliza la URL a un nombre de archivo del portal (p. ej. `index.html`) o `undefined`.
 * Es la ÚNICA normalización: la usan tanto el servidor del protocolo como la guarda de navegación
 * de la vista, para que ambos interpreten la misma URL igual. Coincidencia exacta con la lista blanca
 * y con la ruta canónica; cualquier variante (`enviado.html/`, `enviado%2Ehtml`, `ENVIADO.HTML`) se rechaza.
 */
export function portalFileOf(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${PORTAL_SCHEME}:` || url.host !== PORTAL_HOST) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const segments = path.split(/[\\/]+/).filter((s) => s !== '');
  if (segments.length !== 1) return undefined;
  const name = segments[0] as string;
  // Solo la forma canónica `/<nombre>`: sin barra final, sin escapes, sin `.`/`..`, sensible a mayúsculas.
  if (!PORTAL_FILES.includes(name) || url.pathname !== `/${name}`) return undefined;
  return name;
}

/** Devuelve el archivo dentro de `root` que corresponde a la URL, o `undefined` si no está permitido. */
export async function resolvePortalFile(root: string, rawUrl: string): Promise<string | undefined> {
  const name = portalFileOf(rawUrl);
  if (!name) return undefined;
  try {
    const realRoot = await realpath(root);
    const file = await realpath(join(realRoot, name));
    if (!file.startsWith(realRoot + sep)) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

export function createPortalSession(rootDir: string): Session {
  const ses = electronSession.fromPartition(`portal-${randomUUID()}`, { cache: false });
  const log: string[] = [];
  blocked.set(ses, log);

  ses.protocol.handle(PORTAL_SCHEME, async (req) => {
    if (req.method !== 'GET') return new Response(null, { status: 405 });
    const file = await resolvePortalFile(rootDir, req.url);
    if (!file) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  ses.webRequest.onBeforeRequest((details, cb) => {
    let allowed = false;
    try {
      const u = new URL(details.url);
      allowed = u.protocol === `${PORTAL_SCHEME}:` && u.host === PORTAL_HOST;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      log.push(details.url.slice(0, 200));
      if (log.length > 50) log.shift();
    }
    cb({ cancel: !allowed });
  });

  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  return ses;
}
