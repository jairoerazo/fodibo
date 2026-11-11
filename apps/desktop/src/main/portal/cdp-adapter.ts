// Adaptador del portal sobre CDP (`webContents.debugger`).
//
// Garantías:
// - Todo el código que se ejecuta en la página son las funciones fijas de este archivo, en un
//   mundo aislado; los valores (nombres de campo, texto a escribir) viajan como argumentos de
//   `Runtime.callFunctionOn`, nunca como código. Ningún texto del modelo ni de la página se evalúa.
// - Los `field_id` son opacos (`c1`, `c2`, …), se reasignan en cada `observarPaso` y se invalidan
//   al avanzar o si cambia el documento. Un id anterior lanza.
// - Nunca se accede al botón `button[data-action="submit"]` ni a la casilla de confirmación:
//   no se exponen, no se pueden rellenar y `avanzarPaso` se niega en el resumen.
// - Cada orden CDP tiene un tiempo límite; `detach()` es idempotente y rechaza las órdenes en vuelo.
import type { WebContents } from 'electron';
import type { FieldType, ObservedField, ObservedStep, PortalAdapter } from '../../core/agent/types.js';

const COMMAND_TIMEOUT_MS = 10_000;
const ADVANCE_TIMEOUT_MS = 5_000;
const WORLD_NAME = 'fodibo-agente';

/** Campos que el agente nunca puede ver ni tocar. */
const FORBIDDEN_NAMES = ['p5_bestaetigung'];

// ---------------------------------------------------------------------------------------------
// Funciones fijas que se ejecutan en el mundo aislado (JS clásico, sin dependencias).
// ---------------------------------------------------------------------------------------------

const PAGE_HELPERS = `
  function shown(el) {
    if (!el || el.closest('[hidden]')) return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  function currentSection() {
    var secs = Array.prototype.slice.call(document.querySelectorAll('section[data-step]'));
    var vis = secs.filter(shown);
    if (vis.length !== 1) return { error: 'No hay exactamente un paso visible (' + vis.length + ')', total: secs.length };
    return { section: vis[0], total: secs.length };
  }
  function fieldsOf(s, forbidden) {
    return Array.prototype.slice.call(s.querySelectorAll('input[name], select[name], textarea[name]')).filter(function (el) {
      return el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' && forbidden.indexOf(el.name) < 0 && shown(el);
    });
  }
  function readValue(el) {
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    return String(el.value);
  }
  function errorsOf(s) {
    var out = [];
    Array.prototype.slice.call(s.querySelectorAll('.errors')).forEach(function (ul) {
      if (!shown(ul)) return;
      var lis = ul.querySelectorAll('li');
      if (lis.length) Array.prototype.slice.call(lis).forEach(function (li) { var t = li.textContent.trim(); if (t) out.push(t); });
      else { var t = ul.textContent.trim(); if (t) out.push(t); }
    });
    return out;
  }
  function hasSubmit(s) {
    return Array.prototype.slice.call(s.querySelectorAll('button[data-action="submit"]')).some(shown);
  }
  function center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var hit = document.elementFromPoint(x, y);
    var ok = !!hit && (hit === el || el.contains(hit) || (el.labels && Array.prototype.some.call(el.labels, function (l) { return l === hit || l.contains(hit); })));
    return { x: x, y: y, ok: ok && r.width > 0 && r.height > 0 };
  }
`;

/** Observa el paso visible. Argumentos: lista de nombres prohibidos. */
const FN_OBSERVE = `function (forbidden) {
  ${PAGE_HELPERS}
  var cur = currentSection();
  if (cur.error) return { error: cur.error };
  var s = cur.section;
  var allowed = ['text', 'date', 'amount', 'iban', 'select', 'checkbox'];
  var fields = fieldsOf(s, forbidden).map(function (el) {
    var t = el.getAttribute('data-type');
    if (allowed.indexOf(t) < 0) t = el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' ? 'checkbox' : 'text';
    var label = el.labels && el.labels.length ? el.labels[0].textContent.trim() : '';
    var box = el.closest('.field');
    var help = box && box.querySelector('small.help') ? box.querySelector('small.help').textContent.trim() : '';
    var f = { name: el.name, label: label, help: help, type: t, required: !!el.required, value: readValue(el) };
    if (el.tagName === 'SELECT') {
      f.options = Array.prototype.slice.call(el.options).map(function (o) { return o.value; }).filter(function (v) { return v !== ''; });
    }
    return f;
  });
  return {
    index: Number(s.getAttribute('data-step')),
    total: cur.total,
    title: s.getAttribute('data-title') || '',
    isSummary: hasSubmit(s),
    fields: fields,
    errors: errorsOf(s)
  };
}`;

/**
 * Opera sobre un campo del paso visible. Argumentos: nombres prohibidos, nombre, número de paso,
 * acción ('locate' | 'focus' | 'blur' | 'select' | 'read') y valor (solo 'select').
 */
const FN_FIELD = `function (forbidden, name, step, action, value) {
  ${PAGE_HELPERS}
  var cur = currentSection();
  if (cur.error) return { error: cur.error };
  var s = cur.section;
  if (Number(s.getAttribute('data-step')) !== step) return { error: 'El paso visible ya no es el observado' };
  var el = null;
  fieldsOf(s, forbidden).forEach(function (f) { if (f.name === name) el = f; });
  if (!el) return { error: 'Campo no encontrado en el paso visible' };
  if (action === 'read') return { value: readValue(el) };
  if (el.disabled || el.readOnly) return { error: 'Campo de solo lectura' };
  if (action === 'locate') {
    var c = center(el);
    return { x: c.x, y: c.y, ok: c.ok, checked: el.type === 'checkbox' ? el.checked : null, tag: el.tagName, kind: el.type };
  }
  if (action === 'focus') {
    el.focus();
    if (typeof el.select === 'function') el.select();
    return { focused: document.activeElement === el };
  }
  if (action === 'blur') { el.blur(); return {}; }
  if (action === 'select') {
    if (el.tagName !== 'SELECT') return { error: 'El campo no es una lista' };
    var opt = null;
    Array.prototype.slice.call(el.options).forEach(function (o) {
      if (!opt && o.value !== '' && (o.value === value || o.textContent.trim() === value)) opt = o;
    });
    if (!opt) return { error: 'La opción no existe en la lista' };
    el.focus();
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return {};
  }
  return { error: 'Acción desconocida' };
}`;

/** Localiza «Weiter» en el paso visible. Se niega si el paso es el resumen. */
const FN_NEXT = `function () {
  ${PAGE_HELPERS}
  var cur = currentSection();
  if (cur.error) return { error: cur.error };
  var s = cur.section;
  if (hasSubmit(s)) return { summary: true };
  var btn = null;
  Array.prototype.slice.call(s.querySelectorAll('button[data-action="next"]')).forEach(function (b) { if (!btn && shown(b)) btn = b; });
  if (!btn || btn.disabled) return { error: 'No hay botón «Weiter» en el paso visible' };
  var c = center(btn);
  return { x: c.x, y: c.y, ok: c.ok, step: Number(s.getAttribute('data-step')) };
}`;

/** Estado mínimo para esperar el resultado de «Weiter». */
const FN_STATE = `function () {
  ${PAGE_HELPERS}
  var cur = currentSection();
  if (cur.error) return { step: null, errors: 0 };
  return { step: Number(cur.section.getAttribute('data-step')), errors: errorsOf(cur.section).length };
}`;

// ---------------------------------------------------------------------------------------------

interface Mapped {
  name: string;
  type: FieldType;
  step: number;
  loaderId: string;
}

interface World {
  loaderId: string;
  contextId: number;
}

interface RawField {
  name: string;
  label: string;
  help: string;
  type: FieldType;
  required: boolean;
  value: string;
  options?: string[];
}

interface Pending {
  reject: (e: Error) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CdpAdapter implements PortalAdapter {
  private isAttached = false;
  /** Se incrementa en cada attach/detach: invalida las operaciones en curso. */
  private epoch = 0;
  private world: World | undefined;
  private mapping = new Map<string, Mapped>();
  private readonly pending = new Set<Pending>();
  private readonly onDetach = (): void => this.markDetached('El depurador se desconectó');

  constructor(private readonly wc: WebContents) {}

  get attached(): boolean {
    return this.isAttached;
  }

  async attach(): Promise<void> {
    if (this.isAttached) return;
    if (this.wc.isDestroyed()) throw new Error('La vista del portal ya no existe');
    this.wc.debugger.attach('1.3');
    this.isAttached = true;
    this.epoch++;
    this.wc.debugger.on('detach', this.onDetach);
    try {
      await this.ensureWorld(this.epoch);
    } catch (e) {
      this.detach();
      throw e;
    }
  }

  /** Revoca las herramientas y desconecta el depurador. Idempotente; seguro con órdenes en vuelo. */
  detach(): void {
    if (!this.isAttached) return;
    this.markDetached('Adaptador desconectado');
    if (!this.wc.isDestroyed() && this.wc.debugger.isAttached()) {
      try {
        this.wc.debugger.detach();
      } catch {
        // Ya desconectado.
      }
    }
  }

  private markDetached(reason: string): void {
    if (!this.isAttached) return;
    this.isAttached = false;
    this.epoch++;
    this.world = undefined;
    this.mapping = new Map();
    if (!this.wc.isDestroyed()) this.wc.debugger.removeListener('detach', this.onDetach);
    const err = new Error(reason);
    for (const p of [...this.pending]) p.reject(err);
    this.pending.clear();
  }

  // ------------------------------------------------------------------------- herramientas

  async observarPaso(): Promise<ObservedStep> {
    const epoch = this.begin();
    const world = await this.ensureWorld(epoch);
    const raw = (await this.call(epoch, world, FN_OBSERVE, [FORBIDDEN_NAMES])) as
      | { error: string }
      | { index: number; total: number; title: string; isSummary: boolean; fields: RawField[]; errors: string[] };
    if ('error' in raw) throw new Error(`observarPaso: ${raw.error}`);
    if (!Number.isInteger(raw.index) || raw.index < 1) throw new Error('observarPaso: número de paso inválido');

    const mapping = new Map<string, Mapped>();
    const fields: ObservedField[] = raw.fields.map((f, i) => {
      const field_id = `c${i + 1}`;
      mapping.set(field_id, { name: f.name, type: f.type, step: raw.index, loaderId: world.loaderId });
      const out: ObservedField = {
        field_id,
        label: f.label,
        help: f.help,
        type: f.type,
        required: f.required,
        value: f.value,
      };
      if (f.options) out.options = f.options;
      return out;
    });
    this.mapping = mapping;
    return {
      index: raw.index,
      total: raw.total,
      title: raw.title,
      isSummary: raw.isSummary,
      fields,
      errors: raw.errors,
    };
  }

  async rellenarCampo(fieldId: string, valor: string): Promise<void> {
    const epoch = this.begin();
    if (typeof valor !== 'string') throw new Error('rellenarCampo: el valor debe ser texto');
    const { m, world } = await this.resolve(epoch, fieldId);
    const field = (action: string, value?: string): Promise<Record<string, unknown>> =>
      this.fieldOp(epoch, world, m, action, value);

    if (m.type === 'select') {
      await field('select', valor);
      return;
    }
    if (m.type === 'checkbox') {
      if (valor !== 'true' && valor !== 'false') throw new Error('rellenarCampo: casilla espera «true» o «false»');
      const loc = await field('locate');
      if (loc['checked'] === (valor === 'true')) return;
      if (!loc['ok']) throw new Error('rellenarCampo: la casilla no es visible o está tapada');
      await this.click(epoch, loc['x'] as number, loc['y'] as number);
      return;
    }
    // Texto, fecha, importe, IBAN: foco + seleccionar todo + escritura como un usuario.
    await field('locate');
    const foc = await field('focus');
    if (!foc['focused']) throw new Error('rellenarCampo: no se pudo poner el foco en el campo');
    if (valor === '') {
      await this.send(epoch, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await this.send(epoch, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    } else {
      await this.send(epoch, 'Input.insertText', { text: valor });
    }
    await field('blur');
  }

  async leerCampo(fieldId: string): Promise<string> {
    const epoch = this.begin();
    const { m, world } = await this.resolve(epoch, fieldId);
    const r = await this.fieldOp(epoch, world, m, 'read');
    return String(r['value']);
  }

  async avanzarPaso(): Promise<void> {
    const epoch = this.begin();
    const world = await this.ensureWorld(epoch);
    const loc = (await this.call(epoch, world, FN_NEXT, [])) as {
      error?: string;
      summary?: boolean;
      x?: number;
      y?: number;
      ok?: boolean;
      step?: number;
    };
    if (loc.summary) throw new Error('avanzarPaso: el paso actual es el resumen; el envío corresponde al usuario');
    if (loc.error) throw new Error(`avanzarPaso: ${loc.error}`);
    if (!loc.ok || loc.x === undefined || loc.y === undefined) throw new Error('avanzarPaso: «Weiter» no es visible o está tapado');
    // Los ids del paso actual dejan de valer en cuanto se pulsa «Weiter».
    this.mapping = new Map();
    await this.click(epoch, loc.x, loc.y);

    const end = Date.now() + ADVANCE_TIMEOUT_MS;
    for (;;) {
      const w = await this.ensureWorld(epoch);
      if (w.loaderId !== world.loaderId) throw new Error('avanzarPaso: el portal cambió de página');
      const st = (await this.call(epoch, w, FN_STATE, [])) as { step: number | null; errors: number };
      if (st.step !== loc.step || st.errors > 0) return;
      if (Date.now() >= end) throw new Error('avanzarPaso: el paso no cambió ni mostró errores en 5 s');
      await sleep(100);
    }
  }

  // ------------------------------------------------------------------------- internos

  private begin(): number {
    if (!this.isAttached) throw new Error('Adaptador no conectado');
    return this.epoch;
  }

  private async resolve(epoch: number, fieldId: string): Promise<{ m: Mapped; world: World }> {
    const m = typeof fieldId === 'string' ? this.mapping.get(fieldId) : undefined;
    if (!m) throw new Error(`field_id desconocido o de una observación anterior: «${String(fieldId).slice(0, 40)}»`);
    const world = await this.ensureWorld(epoch);
    if (world.loaderId !== m.loaderId) {
      this.mapping = new Map();
      throw new Error('El portal se recargó o cambió de página; hay que observar el paso de nuevo');
    }
    return { m, world };
  }

  private async fieldOp(epoch: number, world: World, m: Mapped, action: string, value?: string): Promise<Record<string, unknown>> {
    const r = (await this.call(epoch, world, FN_FIELD, [FORBIDDEN_NAMES, m.name, m.step, action, value ?? null])) as Record<
      string,
      unknown
    >;
    if (typeof r['error'] === 'string') throw new Error(`Campo: ${r['error']}`);
    return r;
  }

  private async click(epoch: number, x: number, y: number): Promise<void> {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send(epoch, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send(epoch, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send(epoch, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  /** Mundo aislado del documento actual; se recrea si el documento cambió. */
  private async ensureWorld(epoch: number): Promise<World> {
    const tree = (await this.send(epoch, 'Page.getFrameTree')) as { frameTree: { frame: { id: string; loaderId: string } } };
    const { id: frameId, loaderId } = tree.frameTree.frame;
    if (this.world && this.world.loaderId === loaderId) return this.world;
    const created = (await this.send(epoch, 'Page.createIsolatedWorld', {
      frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: false,
    })) as { executionContextId: number };
    this.world = { loaderId, contextId: created.executionContextId };
    return this.world;
  }

  /** Ejecuta una de las funciones fijas en el mundo aislado; los argumentos viajan como valores. */
  private async call(epoch: number, world: World, fn: string, args: unknown[]): Promise<unknown> {
    const res = (await this.send(epoch, 'Runtime.callFunctionOn', {
      functionDeclaration: fn,
      executionContextId: world.contextId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: false,
      silent: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (res.exceptionDetails) {
      this.world = undefined;
      throw new Error(`Error al evaluar en el portal: ${String(res.exceptionDetails.text ?? '').slice(0, 200)}`);
    }
    const v = res.result?.value;
    if (typeof v !== 'object' || v === null) throw new Error('Respuesta inesperada del portal');
    return v;
  }

  /** Orden CDP con tiempo límite; se rechaza si el adaptador se desconecta mientras espera. */
  private send(epoch: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isAttached || epoch !== this.epoch) return Promise.reject(new Error('Adaptador desconectado'));
    if (this.wc.isDestroyed()) return Promise.reject(new Error('La vista del portal ya no existe'));
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const entry: Pending = {
        reject: (e) => finish(() => reject(e)),
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`Tiempo agotado (${COMMAND_TIMEOUT_MS / 1000} s) en ${method}`))),
        COMMAND_TIMEOUT_MS,
      );
      const finish = (f: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(entry);
        f();
      };
      this.pending.add(entry);
      let sent: Promise<unknown>;
      try {
        sent = this.wc.debugger.sendCommand(method, params);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
        return;
      }
      sent.then(
        (r: unknown) =>
          finish(() => {
            if (epoch !== this.epoch) reject(new Error('Adaptador desconectado'));
            else resolve(r);
          }),
        (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
      );
    });
  }
}
