// Banco de pruebas del adaptador CDP contra el portal de prueba (modo `--selftest-adapter`).
// Abre la vista en una ventana oculta, recorre los 5 pasos con una asignación fija,
// comprueba el bloqueo del envío y de la red, imprime una línea `SELFTEST:{json}` y sale.
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatForField, normalize } from '../../core/agent/format.js';
import type { Declaration, ObservedField } from '../../core/agent/types.js';
import { CdpAdapter } from './cdp-adapter.js';
import { blockedRequests, createPortalSession, portalRoot } from './protocol.js';
import { PortalView } from './view.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

interface Expected {
  source?: string;
  pending?: boolean;
  empty?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

async function throws(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Asignación fija `paso/etiqueta` → clave de la declaración (la etiqueta puede contener «/»). */
function loadExpected(root: string): Map<string, Expected> {
  const raw = JSON.parse(readFileSync(join(root, 'esperado.json'), 'utf8')) as Record<string, Expected>;
  const out = new Map<string, Expected>();
  for (const [k, v] of Object.entries(raw)) {
    const i = k.indexOf('/');
    out.set(`${k.slice(0, i)}/${k.slice(i + 1)}`, v);
  }
  return out;
}

function valueFor(decl: Declaration, exp: Expected, field: ObservedField): string | undefined {
  if (!exp.source) return undefined;
  const entry = decl[exp.source];
  if (!entry) throw new Error(`Clave inexistente en la declaración: ${exp.source}`);
  // El select del portal está en alemán; la declaración usa el valor canónico en español.
  if (field.type === 'select' && entry.valor === 'casado') return 'verheiratet';
  return formatForField(entry, field);
}

export async function runAdapterSelftest(): Promise<number> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  const root = portalRoot();
  const expected = loadExpected(root);
  const decl = JSON.parse(readFileSync(join(root, 'declaracion.json'), 'utf8')) as Declaration;

  const ses = createPortalSession(root);
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const view = new PortalView(win, ses);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  const wc = view.webContents;
  const adapter = new CdpAdapter(wc);
  let submitBlockedEvents = 0;
  view.onSubmitBlocked(() => {
    submitBlockedEvents++;
  });

  try {
    await view.load();
    view.setAgentActive(true);
    await adapter.attach();
    check('attach', adapter.attached);

    // Foco 4: ids de una observación anterior a una recarga dejan de valer.
    const first = await adapter.observarPaso();
    const oldId = first.fields[0]?.field_id ?? 'c1';
    await view.load();
    const errOld = await throws(() => adapter.rellenarCampo(oldId, 'X'));
    check('recarga: field_id antiguo lanza (rellenar)', errOld !== undefined, errOld);
    const errOldRead = await throws(() => adapter.leerCampo(oldId));
    check('recarga: field_id antiguo lanza (leer)', errOldRead !== undefined, errOldRead);

    for (let n = 1; n <= 4; n++) {
      const step = await adapter.observarPaso();
      check(`paso ${n}: observado`, step.index === n && step.total === 5 && !step.isSummary, `${step.index}/${step.total} ${step.title}`);
      const errUnknown = await throws(() => adapter.rellenarCampo('c999', 'X'));
      check(`paso ${n}: field_id inexistente lanza`, errUnknown !== undefined, errUnknown);

      for (const f of step.fields) {
        const exp = expected.get(`${n}/${f.label}`);
        if (!exp) {
          check(`paso ${n}: etiqueta conocida «${f.label}»`, false);
          continue;
        }
        const v = valueFor(decl, exp, f);
        if (v === undefined) continue;
        await adapter.rellenarCampo(f.field_id, v);
        const read = await adapter.leerCampo(f.field_id);
        check(`paso ${n}: ${f.label}`, normalize(f.type, read) === normalize(f.type, v), `escrito «${v}», leído «${read}»`);

        if (n === 1 && f.label === 'Name') {
          // Foco 3: el usuario cambia el campo; leerCampo refleja lo que muestra la página.
          await wc.executeJavaScript(
            `(() => { const el = document.querySelector('input[name="p1_f1"]'); el.value = 'Meier'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
          );
          const after = await adapter.leerCampo(f.field_id);
          check('foco 3: leerCampo ve el cambio del usuario', after === 'Meier', after);
          await adapter.rellenarCampo(f.field_id, v);
          check('foco 3: reescritura', (await adapter.leerCampo(f.field_id)) === v);
        }
      }
      if (n === 1) {
        // Fecha inválida: avanzarPaso termina con errores visibles y sin cambiar de paso.
        const date = step.fields.find((g) => g.type === 'date');
        if (!date) throw new Error('El paso 1 no tiene campo de fecha');
        await adapter.rellenarCampo(date.field_id, '31.02.1984');
        await adapter.avanzarPaso();
        const again = await adapter.observarPaso();
        check('fecha inválida: errores visibles, mismo paso', again.index === 1 && again.errors.length > 0, again.errors.join(' | '));
        for (const g of again.fields) {
          const e2 = expected.get(`1/${g.label}`);
          const v2 = e2 ? valueFor(decl, e2, g) : undefined;
          if (v2 === undefined) continue;
          await adapter.rellenarCampo(g.field_id, v2);
          const read = await adapter.leerCampo(g.field_id);
          check(`paso 1 (reintento): ${g.label}`, normalize(g.type, read) === normalize(g.type, v2), `leído «${read}»`);
        }
      }
      await adapter.avanzarPaso();
      const next = await adapter.observarPaso();
      check(`paso ${n}: avanza`, next.index === n + 1, `${next.index} errores: ${next.errors.join(' | ')}`);
    }

    const summary = await adapter.observarPaso();
    check('resumen: isSummary', summary.isSummary && summary.index === 5);
    check('resumen: casilla de confirmación no expuesta', summary.fields.length === 0, JSON.stringify(summary.fields));
    const errAdv = await throws(() => adapter.avanzarPaso());
    check('resumen: avanzarPaso lanza', errAdv !== undefined, errAdv);

    // Envío provocado desde la página con el agente activo: se bloquea.
    // El usuario completa los campos pendientes (Verpflegungsmehrkosten, Krankenkassenprämien),
    // marca la casilla y pulsa «Einreichen»: todo desde la página, no desde el adaptador.
    const submitJs = `(() => {
      for (const n of ['p3_f2', 'p3_f4']) { const el = document.querySelector('input[name="' + n + '"]'); if (!el.value) el.value = '0.00'; }
      document.querySelector('input[name="p5_bestaetigung"]').checked = true;
      document.querySelector('button[data-action="submit"]').click();
      return document.querySelector('section[data-step="5"] .errors').textContent;
    })()`;
    const submitErrors = (await wc.executeJavaScript(submitJs)) as string;
    check('envío: sin errores de validación', submitErrors === '', submitErrors);
    const blocked = await waitFor(() => view.blockedSubmits === 1, 3000);
    await sleep(300);
    check('envío bloqueado con agente activo', blocked && submitBlockedEvents === 1 && wc.getURL().endsWith('/index.html'), wc.getURL());

    // Variantes de la URL de envío iniciadas por la página: todas bloqueadas y contadas.
    for (const target of ['enviado.html/?d=W10', 'enviado%2Ehtml?d=W10', 'ENVIADO.HTML?d=W10', './sub/../enviado.html?d=W10', 'declaracion.json']) {
      const before = view.blockedSubmits;
      await wc.executeJavaScript(`location.assign(new URL(${JSON.stringify(target)}, location.href).href)`);
      const ok = await waitFor(() => view.blockedSubmits === before + 1, 3000);
      await sleep(200);
      check(`variante bloqueada: ${target}`, ok && wc.getURL().endsWith('/index.html'), `${view.blockedSubmits} ${wc.getURL()}`);
    }
    const blockedTotal = view.blockedSubmits;
    check('oyente notificado en cada bloqueo', submitBlockedEvents === blockedTotal, String(submitBlockedEvents));

    // Red: una petición fuera del protocolo se cancela en la sesión.
    const net = (await wc.executeJavaScript(
      `fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'ok', (e) => 'error: ' + e.message)`,
    )) as string;
    const seen = blockedRequests(ses).some((u) => u.startsWith('https://example.com'));
    check('red: https://example.com cancelada', net !== 'ok' && seen, net);

    // Protocolo: tipos MIME correctos y sin salir de la raíz del portal.
    const probe = (u: string): Promise<string> =>
      ses.fetch(u).then(
        (r) => `${r.status} ${r.headers.get('content-type') ?? ''}`.trim(),
        () => 'error',
      );
    const proto = await Promise.all([
      probe('fodibo-portal://portal/portal.js'),
      probe('fodibo-portal://portal/enviado.html'),
      probe('fodibo-portal://portal/declaracion.json'),
      probe('fodibo-portal://portal/esperado.json'),
      probe('fodibo-portal://portal/enviado.html/'),
      probe('fodibo-portal://portal/enviado%2Ehtml'),
      probe('fodibo-portal://portal/..%2f..%2fpackage.json'),
      probe('fodibo-portal://portal/%2e%2e/%2e%2e/package.json'),
      probe('fodibo-portal://portal/__tests__/portal.test.ts'),
      probe('fodibo-portal://otro/index.html'),
    ]);
    check(
      'protocolo: MIME, lista blanca (sin *.json) y rechazo de rutas fuera de la raíz',
      proto[0] === '200 text/javascript; charset=utf-8' &&
        proto[1] === '200 text/html; charset=utf-8' &&
        proto.slice(2).every((x) => x.startsWith('404') || x === 'error'),
      proto.join(' | '),
    );

    // Detener con una orden en vuelo: no se cuelga.
    const pending = adapter.observarPaso();
    adapter.detach();
    adapter.detach();
    const t0 = Date.now();
    const errPending = await throws(() => pending);
    check('detach con orden pendiente: rechaza o termina sin colgarse', Date.now() - t0 < 2000, errPending ?? 'resuelta');
    check('detach: attached=false', !adapter.attached && !wc.debugger.isAttached());
    const errAfter = await throws(() => adapter.observarPaso());
    check('tras detach: herramientas revocadas', errAfter !== undefined, errAfter);

    // Con el agente inactivo, el mismo envío navega a enviado.html.
    view.setAgentActive(false);
    await wc.executeJavaScript(submitJs);
    const navigated = await waitFor(() => wc.getURL().includes('/enviado.html'), 5000);
    check('envío manual navega a enviado.html', navigated && view.blockedSubmits === blockedTotal, wc.getURL().slice(0, 80));
  } catch (e) {
    check('excepción', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  } finally {
    adapter.detach();
    view.destroy();
    win.destroy();
  }

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  process.stdout.write(`SELFTEST:${JSON.stringify({ ok, checks })}\n`);
  return ok ? 0 : 1;
}

export function startAdapterSelftest(): void {
  const guard = setTimeout(() => {
    process.stdout.write(`SELFTEST:${JSON.stringify({ ok: false, checks: [{ name: 'timeout global', ok: false }] })}\n`);
    app.exit(1);
  }, 90_000);
  app.dock?.hide();
  void app
    .whenReady()
    .then(runAdapterSelftest)
    .catch((e: unknown) => {
      process.stdout.write(`SELFTEST:${JSON.stringify({ ok: false, checks: [{ name: 'arranque', ok: false, detail: String(e) }] })}\n`);
      return 1;
    })
    .then((code) => {
      clearTimeout(guard);
      app.exit(code);
    });
}
