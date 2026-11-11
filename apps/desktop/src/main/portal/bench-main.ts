// Bancos de pruebas con Electron y la ventana oculta:
// - `--selftest-adapter`: recorre los 5 pasos con una asignación fija (sin modelo), comprueba el
//   bloqueo del envío y de la red, imprime una línea `SELFTEST:{json}` y sale.
// - `--bench [--runs=3]`: ejecuta el agente completo con `FODIBO_MODEL` N veces, puntúa contra
//   `esperado.json`, mide tiempo por paso y memoria, escribe `bench-report.json` y sale.
import { app, BrowserWindow } from 'electron';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { accept, parseExpected, scoreRun, type ExpectedField, type RunScore } from '../../core/agent/bench.js';
import { loadDeclaration } from '../../core/agent/declaration.js';
import { formatForField, normalize } from '../../core/agent/format.js';
import { createLlamaClient } from '../../core/agent/model-client.js';
import { AgentOrchestrator, type AgentState } from '../../core/agent/orchestrator.js';
import type { Declaration, FieldResult, ObservedField, ObservedStep, PortalAdapter } from '../../core/agent/types.js';
import { CdpAdapter } from './cdp-adapter.js';
import { LlamaServer, MSG_NO_MODEL } from './llama.js';
import { blockedRequests, createPortalSession, PORTAL_DENY_PROXY, portalRoot } from './protocol.js';
import { PortalView } from './view.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
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

/** Asignación fija `paso/etiqueta` → clave de la declaración, leída de `esperado.json`. */
function loadExpected(root: string): Map<string, ExpectedField> {
  const out = new Map<string, ExpectedField>();
  for (const [k, v] of parseExpected(JSON.parse(readFileSync(join(root, 'esperado.json'), 'utf8')))) out.set(k, v.expected);
  return out;
}

function valueFor(decl: Declaration, exp: ExpectedField, field: ObservedField): string | undefined {
  if (!('source' in exp)) return undefined;
  const entry = decl[exp.source];
  if (!entry) throw new Error(`Clave inexistente en la declaración: ${exp.source}`);
  // El select del portal está en alemán; esperado.json fija la opción exacta.
  if (field.type === 'select') {
    if (exp.option === undefined) throw new Error(`esperado.json no fija la opción de «${field.label}»`);
    return exp.option;
  }
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
    check('carga del portal con la red endurecida', wc.getURL().endsWith('/index.html'), wc.getURL());
    const policy = wc.getWebRTCIPHandlingPolicy();
    check('red: WebRTC sin UDP fuera del proxy', policy === 'disable_non_proxied_udp', policy);
    const proxy = await ses.resolveProxy('https://example.com/');
    check('red: proxy de denegación en la sesión', proxy.includes(PORTAL_DENY_PROXY.proxyRules), proxy);
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

// =============================================================================================
// Modo `--bench`
// =============================================================================================

export interface BenchRun {
  score: RunScore;
  /** Milisegundos por paso: desde que se observa el paso hasta que el portal avanza. */
  stepMs: Record<string, number>;
  /** Pico de memoria residente durante la ejecución, en MB. */
  rssMb: { llamaServer: number; electron: number };
  state: AgentState;
  message?: string;
  totalMs: number;
}

export interface BenchReport {
  model: string;
  sha256: string;
  /** `args`: lista completa de argumentos con la que se lanzó `llama-server`. */
  llamaServer: { binary: string; version: string; args: string[] };
  runs: BenchRun[];
  accept: { ok: boolean; reasons: string[] };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function llamaVersion(binary: string): string {
  // `llama-server --version` escribe en stderr.
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').map((l) => l.trim());
  return lines.find((l) => l.startsWith('version')) ?? 'desconocida';
}

function rssKbOf(pid: number | undefined): number {
  if (pid === undefined) return 0;
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

function electronRssKb(): number {
  // `workingSetSize` en KB, sumado sobre todos los procesos de Electron (principal, GPU, renderers).
  return app.getAppMetrics().reduce((acc, m) => acc + (m.memory.workingSetSize || 0), 0);
}

/** Envuelve el adaptador para medir el tiempo de cada paso y registrar las opciones de los `select`. */
function instrument(adapter: PortalAdapter): { adapter: PortalAdapter; stepMs: Record<string, number>; options: Record<string, string[]> } {
  const stepMs: Record<string, number> = {};
  const options: Record<string, string[]> = {};
  let current: { index: number; t0: number } | undefined;
  const wrapped: PortalAdapter = {
    async observarPaso(): Promise<ObservedStep> {
      const step = await adapter.observarPaso();
      if (!step.isSummary && current?.index !== step.index) current = { index: step.index, t0: Date.now() };
      for (const f of step.fields) if (f.options) options[`${step.index}/${f.label}`] = f.options;
      return step;
    },
    rellenarCampo: (id, v) => adapter.rellenarCampo(id, v),
    leerCampo: (id) => adapter.leerCampo(id),
    async avanzarPaso(): Promise<void> {
      await adapter.avanzarPaso();
      if (current) stepMs[String(current.index)] = Date.now() - current.t0;
    },
  };
  return { adapter: wrapped, stepMs, options };
}

const out = (line: string): void => {
  process.stdout.write(`[bench] ${line}\n`);
};

function summarize(report: BenchReport): string {
  const lines = [`Modelo: ${report.model} (sha256 ${report.sha256.slice(0, 16)}…)`, `llama-server: ${report.llamaServer.version}`];
  report.runs.forEach((r, i) => {
    const s = r.score;
    const steps = Object.entries(r.stepMs)
      .map(([k, v]) => `p${k} ${(v / 1000).toFixed(1)} s`)
      .join(', ');
    lines.push(
      `Ejecución ${i + 1}: ${s.correct}/${s.withData} correctos, ${s.wrong} equivocados, ${s.invented} inventados, ` +
        `pendientes ${s.pendingOk} ok / ${s.pendingMissed} fallidos, ${s.blockedSubmits} envíos bloqueados, estado ${r.state}` +
        `${r.message ? ` (${r.message})` : ''}`,
    );
    lines.push(`  tiempo: ${(r.totalMs / 1000).toFixed(1)} s [${steps}]; RSS pico: llama-server ${r.rssMb.llamaServer} MB, Electron ${r.rssMb.electron} MB`);
    for (const f of s.failures) lines.push(`  fallo ${f.key}: esperado ${JSON.stringify(f.expected)}, obtenido ${JSON.stringify(f.got)}`);
  });
  lines.push(report.accept.ok ? 'ACEPTADO' : `NO ACEPTADO:\n  ${report.accept.reasons.join('\n  ')}`);
  return lines.join('\n');
}

export async function runBench(argv: string[], env: NodeJS.ProcessEnv, llama: { current?: LlamaServer }): Promise<number> {
  const runsArg = argv.find((a) => a.startsWith('--runs='));
  const runs = runsArg ? Number(runsArg.slice('--runs='.length)) : 3;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs no válido: ${runsArg ?? ''}`);
  const modelPath = env['FODIBO_MODEL'];
  if (!modelPath) throw new Error(MSG_NO_MODEL);
  const binary = env['FODIBO_LLAMA_SERVER'] || 'llama-server';
  const threads = env['FODIBO_THREADS'] || '4';
  const extraArgs = ['-t', threads];

  const root = portalRoot();
  const expectedMap = parseExpected(JSON.parse(readFileSync(join(root, 'esperado.json'), 'utf8')));
  const expected: Record<string, ExpectedField> = {};
  for (const [k, v] of expectedMap) expected[k] = v.expected;
  const decl = loadDeclaration(JSON.parse(readFileSync(join(root, 'declaracion.json'), 'utf8')));

  out(`Calculando SHA-256 de ${modelPath}`);
  const sha256 = await sha256File(modelPath);
  const version = llamaVersion(binary);
  out(`llama-server ${version}; arrancando el modelo (hilos: ${threads})`);
  const server = new LlamaServer({ binary, modelPath, extraArgs, healthTimeoutMs: 300_000 });
  llama.current = server;
  const t0 = Date.now();
  const baseUrl = await server.start();
  out(`Modelo listo en ${((Date.now() - t0) / 1000).toFixed(1)} s (${baseUrl})`);

  const ses = createPortalSession(root);
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const view = new PortalView(win, ses);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  const results: BenchRun[] = [];
  let active: AgentOrchestrator | undefined;
  view.onSubmitBlocked(() => active?.stop());

  try {
    for (let i = 1; i <= runs; i++) {
      out(`Ejecución ${i}/${runs}: recargando el portal`);
      await view.load();
      const cdp = new CdpAdapter(view.webContents);
      const inst = instrument(cdp);
      const baseline = view.blockedSubmits;
      let state: AgentState = 'inactivo';
      let message: string | undefined;
      let peakLlama = 0;
      let peakElectron = 0;
      const sample = (): void => {
        peakLlama = Math.max(peakLlama, rssKbOf(server.pid));
        peakElectron = Math.max(peakElectron, electronRssKb());
      };
      sample();
      const sampler = setInterval(sample, 1000);
      const started = Date.now();
      let fieldResults: FieldResult[] = [];
      try {
        view.setAgentActive(true);
        await cdp.attach();
        const orchestrator = new AgentOrchestrator({
          adapter: inst.adapter,
          model: createLlamaClient(baseUrl),
          declaration: decl,
          getBlockedSubmits: () => view.blockedSubmits - baseline,
          onEvent: (e) => {
            if (e.type === 'log') out(`  ${e.text}`);
            else if (e.type === 'state' && e.state !== 'rellenando') {
              state = e.state;
              message = e.message;
            }
          },
        });
        active = orchestrator;
        fieldResults = await orchestrator.run();
      } catch (e) {
        state = 'error';
        message = e instanceof Error ? e.message : String(e);
      } finally {
        active = undefined;
        clearInterval(sampler);
        sample();
        cdp.detach();
        view.setAgentActive(false);
      }
      const score = scoreRun(fieldResults, expected, decl, view.blockedSubmits - baseline, inst.options);
      const run: BenchRun = {
        score,
        stepMs: inst.stepMs,
        rssMb: { llamaServer: Math.round(peakLlama / 1024), electron: Math.round(peakElectron / 1024) },
        state,
        totalMs: Date.now() - started,
        ...(message !== undefined ? { message } : {}),
      };
      results.push(run);
      out(`Ejecución ${i}: ${score.correct}/${score.withData} correctos, ${score.wrong} equivocados, ${score.invented} inventados, estado ${state}`);
    }
  } finally {
    view.destroy();
    win.destroy();
  }

  const report: BenchReport = {
    model: basename(modelPath),
    sha256,
    llamaServer: { binary, version, args: server.spawnArgs },
    runs: results,
    accept: accept(results.map((r) => r.score)),
  };
  const reportPath = join(app.getAppPath(), 'bench-report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${summarize(report)}\nInforme: ${reportPath}\n`);
  return report.accept.ok ? 0 : 1;
}

export function startBench(): void {
  const llama: { current?: LlamaServer } = {};
  let exiting = false;
  const finish = async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    clearTimeout(guard);
    try {
      await llama.current?.stop();
    } catch {
      // mejor esfuerzo; el proceso se mata igualmente al salir
    }
    out(`Saliendo con código ${code}`);
    app.exit(code);
  };
  const minutes = Number(process.env['FODIBO_BENCH_TIMEOUT_MIN'] || '90');
  const guard = setTimeout(() => {
    out(`Tiempo global agotado (${minutes} min)`);
    void finish(2);
  }, minutes * 60_000);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void finish(130));
  // Sin este oyente, Electron sale con código 0 al destruir la ventana oculta, antes de `finish`.
  app.on('window-all-closed', () => {});
  app.dock?.hide();
  void app
    .whenReady()
    .then(() => runBench(process.argv, process.env, llama))
    .catch((e: unknown) => {
      out(`Error: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    })
    .then((code) => finish(code));
}
