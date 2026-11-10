import { normalize } from './format.js';
import { responseSchema, validateAnswer, type FieldPlan } from './mapping.js';
import { ModelError, type ModelClient } from './model-client.js';
import { buildMessages } from './prompt.js';
import type { Declaration, FieldOutcome, FieldResult, ObservedStep, PortalAdapter } from './types.js';

export type { ModelClient } from './model-client.js';

export type AgentState = 'inactivo' | 'rellenando' | 'entregado' | 'detenido' | 'error';
export type AgentEvent =
  | { type: 'state'; state: AgentState; step?: number; message?: string }
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
      blockedSubmits: 0,
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
    let step = await adapter.observarPaso();
    for (let n = 0; ; n++) {
      this.check();
      if (step.isSummary) return;
      if (n >= maxSteps) throw new Error('el portal no llega al resumen');
      this.emit({ type: 'state', state: 'rellenando', step: step.index });
      this.log(`Paso ${step.index}/${step.total}: ${step.title}`);
      const plan = await this.plan(step);
      if (plan) await this.apply(step, plan);
      else
        for (const f of step.fields)
          this.record(step, f, { kind: 'pending', reason: 'modelo_sin_respuesta', candidates: [] });
      this.check();
      await adapter.avanzarPaso();
      this.check();
      const next = await adapter.observarPaso();
      this.check();
      if (next.index <= step.index && !next.isSummary && next.errors.length > 0) {
        throw new PortalStop(`El portal no deja avanzar: ${next.errors.join('; ')}`, next.index);
      }
      step = next;
    }
  }

  private async plan(step: ObservedStep): Promise<FieldPlan[] | null> {
    const messages = buildMessages(step, this.opts.declaration);
    const schema = responseSchema(step);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.check();
      try {
        const answer = await this.opts.model.complete(messages, schema, this.ac.signal);
        this.check();
        const v = validateAnswer(step, this.opts.declaration, answer);
        if (v.ok) return v.plan;
        this.log(`Respuesta del modelo no válida (${v.error})`);
      } catch (e) {
        this.check();
        if (!(e instanceof ModelError)) throw e;
        this.log(`Error del modelo: ${e.message}`);
      }
    }
    this.log(`Sin respuesta válida del modelo en el paso ${step.index}`);
    return null;
  }

  private async apply(step: ObservedStep, plan: FieldPlan[]): Promise<void> {
    const { adapter } = this.opts;
    for (const p of plan) {
      this.check();
      const f = p.field;
      switch (p.action) {
        case 'keep':
          this.record(step, f, { kind: 'prefilled_ok' });
          break;
        case 'skip':
          this.record(step, f, { kind: 'skipped' });
          break;
        case 'pending':
          this.record(step, f, {
            kind: 'pending',
            reason: p.reason,
            ...(p.detail !== undefined ? { detail: p.detail } : {}),
            candidates: p.candidates,
          });
          break;
        case 'fill': {
          await adapter.rellenarCampo(f.field_id, p.value);
          this.check();
          const read = await adapter.leerCampo(f.field_id);
          this.check();
          if (normalize(f.type, read) === normalize(f.type, p.value)) {
            this.log(`Rellenado ${f.label} desde ${p.source}`);
            this.record(step, f, { kind: 'filled', source: p.source, written: p.value });
          } else {
            this.log(`No se pudo verificar ${f.label}`);
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
