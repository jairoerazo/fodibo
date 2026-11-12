import { CONCEPTS, resolveFromCatalog, type Concept } from './catalog.js';
import { normalize } from './format.js';
import { responseSchema, validateAnswer, type FieldPlan } from './mapping.js';
import { ModelError, type ModelClient } from './model-client.js';
import { buildMessages } from './prompt.js';
import type { Declaration, FieldOutcome, FieldResult, ObservedStep, PortalAdapter } from './types.js';

export type { ModelClient } from './model-client.js';

export type AgentState = 'inactivo' | 'rellenando' | 'entregado' | 'detenido' | 'error';
export type AgentEvent =
  | { type: 'state'; state: AgentState; step?: number; total?: number; message?: string }
  | { type: 'log'; at: string; text: string }
  | { type: 'field'; result: FieldResult }
  | { type: 'finished'; results: FieldResult[]; pending: FieldResult[]; blockedSubmits: number };

class Stopped extends Error {}

export class AgentOrchestrator {
  private readonly ac = new AbortController();
  private stopped = false;
  private started = false;
  private done = false;
  private results: FieldResult[] = [];

  constructor(
    private readonly opts: {
      adapter: PortalAdapter;
      model: ModelClient;
      declaration: Declaration;
      onEvent: (e: AgentEvent) => void;
      maxSteps?: number;
      getBlockedSubmits?: () => number;
      /** Conceptos reconocidos sin modelo; `false` lo desactiva (todo va al modelo). */
      catalog?: readonly Concept[] | false;
    },
  ) {}

  stop(): void {
    this.stopped = true;
    this.ac.abort();
  }

  async run(): Promise<FieldResult[]> {
    if (this.started) return this.results;
    this.started = true;
    let final: { state: AgentState; message?: string; step?: number } = { state: 'entregado' };
    try {
      await this.loop();
    } catch (e) {
      if (this.stopped) final = { state: 'detenido' };
      else if (e instanceof PortalStop) final = { state: 'error', message: e.message, step: e.step };
      else final = { state: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    if (this.stopped && final.state === 'entregado') final = { state: 'detenido' };
    this.finish(final);
    return this.results;
  }

  private safeBlocked(): number {
    try {
      return this.opts.getBlockedSubmits?.() ?? 0;
    } catch {
      return 0;
    }
  }

  private emit(e: AgentEvent): void {
    try {
      this.opts.onEvent(e);
    } catch {
      // un receptor defectuoso no debe romper el agente
    }
  }
  private log(text: string): void {
    this.emit({ type: 'log', at: new Date().toISOString(), text });
  }
  private check(): void {
    if (this.stopped) throw new Stopped();
  }
  private finish(s: { state: AgentState; message?: string; step?: number }): void {
    if (this.done) return;
    this.done = true;
    this.emit({
      type: 'state',
      state: s.state,
      ...(s.step !== undefined ? { step: s.step } : {}),
      ...(s.message !== undefined ? { message: s.message } : {}),
    });
    this.emit({
      type: 'finished',
      results: this.results,
      pending: this.results.filter((r) => r.outcome.kind === 'pending'),
      blockedSubmits: this.safeBlocked(),
    });
  }
  private record(step: ObservedStep, field: FieldPlan['field'], outcome: FieldOutcome): void {
    const result: FieldResult = {
      step: step.index,
      stepTitle: step.title,
      field_id: field.field_id,
      label: field.label,
      required: field.required,
      outcome,
    };
    this.results.push(result);
    this.emit({ type: 'field', result });
  }

  private async loop(): Promise<void> {
    const { adapter } = this.opts;
    const maxSteps = this.opts.maxSteps ?? 10;
    this.check();
    this.log('Observando el paso actual');
    let step = await adapter.observarPaso();
    for (let n = 0; ; n++) {
      this.check();
      if (step.isSummary) return;
      if (n >= maxSteps) {
        this.log(`Se superó el máximo de ${maxSteps} pasos sin llegar al resumen`);
        throw new Error('el portal no llega al resumen');
      }
      this.emit({ type: 'state', state: 'rellenando', step: step.index, total: step.total });
      this.log(`Paso ${step.index}/${step.total}: ${step.title}`);
      await this.fillStep(step);
      this.check();
      this.log(`Avanzando desde el paso ${step.index}`);
      await adapter.avanzarPaso();
      this.check();
      this.log('Observando el nuevo paso');
      const next = await adapter.observarPaso();
      this.check();
      if (next.index <= step.index && !next.isSummary && next.errors.length > 0) {
        this.log(`El portal no deja avanzar: ${next.errors.join('; ')}`);
        throw new PortalStop(`El portal no deja avanzar: ${next.errors.join('; ')}`, next.index);
      }
      step = next;
    }
  }

  /**
   * Resuelve primero con el catálogo los campos cuya etiqueta reconoce (misma validación y escritura que
   * una respuesta del modelo) y deja al modelo solo el resto. Ver `fillWithModel`.
   */
  private async fillStep(step: ObservedStep): Promise<void> {
    const catalog = this.opts.catalog ?? CONCEPTS;
    let rest = step.fields;
    if (catalog !== false) {
      const { answer, resolved } = resolveFromCatalog(step, this.opts.declaration, catalog);
      if (resolved.size > 0) {
        const known = { ...step, fields: step.fields.filter((f) => resolved.has(f.field_id)) };
        const v = validateAnswer(known, this.opts.declaration, answer);
        if (v.ok) {
          this.log(`Catálogo: ${resolved.size} de ${step.fields.length} campos sin modelo`);
          await this.apply(step, v.plan);
          rest = step.fields.filter((f) => !resolved.has(f.field_id));
        }
      }
    }
    this.check();
    if (rest.length > 0) await this.fillWithModel({ ...step, fields: rest });
  }

  /**
   * Pide al modelo la asignación del paso y escribe cada campo en cuanto la respuesta en streaming lo
   * cierra. Cada campo pasa por `validateAnswer` (el mismo paso reducido a ese campo) antes de escribirse;
   * uno no válido espera a la respuesta completa, que se valida entera. Si la respuesta se corta, el
   * reintento solo aplica los campos aún no tratados.
   */
  private async fillWithModel(step: ObservedStep): Promise<void> {
    const decl = this.opts.declaration;
    const messages = buildMessages(step, decl);
    const schema = responseSchema(step, decl);
    const handled = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      this.check();
      // Escrituras en orden, una tras otra; si una falla, se corta la respuesta del modelo.
      const writer = new AbortController();
      let queue = Promise.resolve();
      let writeError: unknown;
      const enqueue = (plan: FieldPlan[]) => {
        for (const p of plan) handled.add(p.field.field_id);
        queue = queue.then(() => this.apply(step, plan)).catch((e: unknown) => {
          writeError ??= e;
          writer.abort();
        });
      };
      const onField = (fieldId: string, value: unknown) => {
        if (writeError !== undefined || this.stopped || handled.has(fieldId)) return;
        const field = step.fields.find((f) => f.field_id === fieldId);
        if (!field) return;
        const v = validateAnswer({ ...step, fields: [field] }, decl, { [fieldId]: value });
        if (v.ok) enqueue(v.plan);
      };
      if (attempt === 0) this.log('Esperando la respuesta del modelo');
      let answer: unknown;
      let failure: string | undefined;
      try {
        answer = await this.opts.model.complete(messages, schema, AbortSignal.any([this.ac.signal, writer.signal]), onField);
      } catch (e) {
        if (!(e instanceof ModelError) && writeError === undefined) {
          await queue;
          throw e;
        }
        failure = e instanceof ModelError ? `Error del modelo: ${e.message}` : String(e);
      }
      await queue;
      if (writeError !== undefined) throw writeError;
      this.check();
      if (failure === undefined) {
        const v = validateAnswer(step, decl, answer);
        if (v.ok) {
          enqueue(v.plan.filter((p) => !handled.has(p.field.field_id)));
          await queue;
          if (writeError !== undefined) throw writeError;
          return;
        }
        failure = `Respuesta del modelo no válida (${v.error})`;
      }
      this.log(failure);
    }
    this.log(`Sin respuesta válida del modelo en el paso ${step.index}`);
    for (const f of step.fields)
      if (!handled.has(f.field_id)) this.record(step, f, { kind: 'pending', reason: 'modelo_sin_respuesta', candidates: [] });
  }

  private async apply(step: ObservedStep, plan: FieldPlan[]): Promise<void> {
    const { adapter } = this.opts;
    for (const p of plan) {
      this.check();
      const f = p.field;
      switch (p.action) {
        case 'keep':
          this.log(`${f.label}: valor previo correcto, se conserva`);
          this.record(step, f, { kind: 'prefilled_ok' });
          break;
        case 'skip':
          this.log(`${f.label}: omitido`);
          this.record(step, f, { kind: 'skipped' });
          break;
        case 'pending':
          this.log(`${f.label}: pendiente (${p.reason})${p.detail ? ` - ${p.detail}` : ''}`);
          this.record(step, f, {
            kind: 'pending',
            reason: p.reason,
            ...(p.detail !== undefined ? { detail: p.detail } : {}),
            candidates: p.candidates,
          });
          break;
        case 'fill': {
          this.log(`Escribiendo ${f.label} ← ${p.value} (desde ${p.source})`);
          await adapter.rellenarCampo(f.field_id, p.value);
          if (this.stopped) {
            this.record(step, f, {
              kind: 'pending',
              reason: 'no_verificado',
              detail: 'detenido antes de verificar',
              candidates: [],
            });
            throw new Stopped();
          }
          const read = await adapter.leerCampo(f.field_id);
          this.check();
          if (normalize(f.type, read) === normalize(f.type, p.value)) {
            this.log(`Verificado ${f.label}: leído "${read}"`);
            this.record(step, f, { kind: 'filled', source: p.source, written: p.value });
          } else {
            this.log(`No se pudo verificar ${f.label}: escrito "${p.value}", leído "${read}"`);
            this.record(step, f, {
              kind: 'pending',
              reason: 'no_verificado',
              detail: 'El valor leído no coincide con el escrito',
              candidates: [],
            });
          }
          break;
        }
      }
    }
  }
}

class PortalStop extends Error {
  constructor(
    message: string,
    readonly step: number,
  ) {
    super(message);
  }
}
