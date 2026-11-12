// IPC del expediente en el proceso principal. El renderer es una entrada no confiable: cada canal valida sus
// argumentos con Ajv antes de llamar al núcleo. No importa `electron` en tiempo de ejecución (recibe `ipcMain`
// por inyección) para poder probarse en Node.
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type, ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { ExpedienteError, type ExpedienteService } from '../core/expediente/index.js';
import { CANTONS, DOC_TYPES, PERSON_ROLES } from '../core/expediente/types.js';
import { CASE_CHANNELS, type Result } from '../shared/expediente-ipc.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true, allErrors: false });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);

export interface IpcMainLike {
  handle(channel: string, listener: (e: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Subconjunto público del servicio que se expone por IPC (`proposeField` queda fuera a propósito). */
export type ExpedienteFacade = Pick<
  ExpedienteService,
  | 'listCases'
  | 'createCase'
  | 'updateCase'
  | 'getCase'
  | 'listConcepts'
  | 'listImportable'
  | 'importPackage'
  | 'setDocument'
  | 'saveField'
  | 'deleteField'
  | 'fieldHistory'
  | 'approve'
  | 'documentLocation'
  | 'on'
>;

export interface ExpedienteIpcOptions {
  showItemInFolder(path: string): void;
  /** Reenvía `case:event` al renderer; sin él no se publican eventos. */
  emit?(channel: string, payload: unknown): void;
}

const UUID = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } as const;
const TEXT = { type: 'string', maxLength: 200 } as const;
const LABEL = { type: 'string', minLength: 1, maxLength: 60 } as const;
const YEAR = { type: 'integer', minimum: 2000, maximum: 2100 } as const;
const CANTON = { enum: [...CANTONS] } as const;
const ROLE = { enum: [...PERSON_ROLES] } as const;
const SLUG = { type: 'string', pattern: '^(hauptperson|partner|kind_[1-9][0-9]{0,5})$' } as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;

const EVIDENCE = obj({ documentId: UUID, page: { type: 'integer', minimum: 0, maximum: 9999 } }, ['documentId', 'page']);

const CASE_INPUT = obj(
  { taxYear: YEAR, jurisdiction: CANTON, persons: { type: 'array', maxItems: 20, items: obj({ role: ROLE, label: LABEL }, ['role', 'label']) } },
  ['taxYear', 'jurisdiction', 'persons'],
);
const CASE_UPDATE = obj({
  taxYear: YEAR,
  jurisdiction: CANTON,
  persons: { type: 'array', maxItems: 20, items: obj({ slug: SLUG, role: ROLE, label: LABEL }, ['role', 'label']) },
});
const DOCUMENT_PATCH = obj({
  docType: { enum: [...DOC_TYPES] },
  status: { enum: ['pendiente_de_revision', 'confirmado', 'descartado'] },
});
const FIELD_INPUT = obj(
  {
    fieldId: UUID,
    conceptId: { type: 'string', minLength: 1, maxLength: 80 },
    variant: { type: 'string', maxLength: 20 },
    valor: { anyOf: [TEXT, { type: 'boolean' }] },
    moneda: { type: 'string', maxLength: 8 },
    evidence: { type: 'array', maxItems: 20, items: EVIDENCE },
  },
  ['conceptId', 'variant', 'valor', 'evidence'],
);
const REVISION = { type: 'integer', minimum: 0, maximum: 2147483647 } as const;

/** Esquema de la lista de argumentos posicionales: longitud exacta y un esquema por posición. */
const args = (...items: unknown[]) =>
  items.length === 0 ? { type: 'array', maxItems: 0 } : { type: 'array', prefixItems: items, items: false, minItems: items.length, maxItems: items.length };

type Call = (svc: ExpedienteFacade, a: never[], opts: ExpedienteIpcOptions) => unknown;
interface Route {
  channel: string;
  schema: unknown;
  call: Call;
}
const route = <A extends unknown[]>(channel: string, schema: unknown, call: (svc: ExpedienteFacade, a: A, opts: ExpedienteIpcOptions) => unknown): Route => ({
  channel,
  schema,
  call: call as unknown as Call,
});

const ROUTES: Route[] = [
  route(CASE_CHANNELS.list, args(), (s) => s.listCases()),
  route(CASE_CHANNELS.create, args(CASE_INPUT), (s, [i]: [Parameters<ExpedienteFacade['createCase']>[0]]) => s.createCase(i)),
  route(CASE_CHANNELS.update, args(UUID, CASE_UPDATE), (s, [id, i]: [string, Parameters<ExpedienteFacade['updateCase']>[1]]) => s.updateCase(id, i)),
  route(CASE_CHANNELS.get, args(UUID), (s, [id]: [string]) => s.getCase(id)),
  route(CASE_CHANNELS.concepts, args(), (s) => s.listConcepts()),
  route(CASE_CHANNELS.importable, args(), (s) => s.listImportable()),
  route(CASE_CHANNELS.import, args(UUID, UUID), (s, [c, p]: [string, string]) => s.importPackage(c, p)),
  route(CASE_CHANNELS.setDocument, args(UUID, DOCUMENT_PATCH), (s, [id, p]: [string, Parameters<ExpedienteFacade['setDocument']>[1]]) => s.setDocument(id, p)),
  route(CASE_CHANNELS.saveField, args(UUID, FIELD_INPUT), (s, [id, i]: [string, Parameters<ExpedienteFacade['saveField']>[1]]) => s.saveField(id, i)),
  route(CASE_CHANNELS.deleteField, args(UUID), (s, [id]: [string]) => s.deleteField(id)),
  route(CASE_CHANNELS.fieldHistory, args(UUID), (s, [id]: [string]) => s.fieldHistory(id)),
  route(CASE_CHANNELS.approve, args(UUID, REVISION), (s, [id, r]: [string, number]) => s.approve(id, r)),
  route(CASE_CHANNELS.showDocument, args(UUID), async (s, [id]: [string], o) => {
    o.showItemInFolder(await s.documentLocation(id));
  }),
];

const fail = (code: string, message: string, details?: unknown): Result<never> => ({
  ok: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export function registerExpedienteIpc(ipc: IpcMainLike, svc: ExpedienteFacade, opts: ExpedienteIpcOptions): () => void {
  // Los esquemas se compilan una sola vez, al registrar.
  const compiled = ROUTES.map((r) => ({ ...r, validate: ajv.compile(r.schema as object) as ValidateFunction }));
  for (const r of compiled) {
    ipc.handle(r.channel, async (_e, ...a) => {
      if (!r.validate(a)) return fail('invalid_input', 'Los datos enviados no son válidos.');
      try {
        return { ok: true, value: await r.call(svc, a as never[], opts) } satisfies Result<unknown>;
      } catch (err) {
        if (err instanceof ExpedienteError) return fail(err.code, err.message, err.details);
        // Solo el código: ni mensajes ni valores del error original llegan a la consola ni al renderer.
        console.error(`[fodibo] ${r.channel}: storage_error`);
        return fail('storage_error', 'Error interno del almacén del expediente.');
      }
    });
  }
  const off = opts.emit ? svc.on((e) => opts.emit?.(CASE_CHANNELS.event, e)) : undefined;
  return () => {
    for (const r of compiled) ipc.removeHandler(r.channel);
    off?.();
  };
}
