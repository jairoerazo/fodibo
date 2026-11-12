import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpedienteError } from '../../core/expediente/index.js';
import { CASE_CHANNELS } from '../../shared/expediente-ipc.js';
import { registerExpedienteIpc, type ExpedienteFacade, type IpcMainLike } from '../expediente-ipc.js';

const ID = randomUUID();
const ID2 = randomUUID();

function harness() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const ipc: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn),
    removeHandler: (ch) => void handlers.delete(ch),
  };
  const calls: Array<[string, unknown[]]> = [];
  const rec = (name: string, ret: unknown = { name }) =>
    vi.fn((...a: unknown[]) => {
      calls.push([name, a]);
      return ret;
    });
  const svc = {
    listCases: rec('listCases', []),
    createCase: rec('createCase'),
    updateCase: rec('updateCase'),
    getCase: rec('getCase'),
    listConcepts: rec('listConcepts', []),
    listImportable: rec('listImportable', []),
    importPackage: rec('importPackage'),
    setDocument: rec('setDocument'),
    saveField: rec('saveField'),
    deleteField: rec('deleteField'),
    fieldHistory: rec('fieldHistory', []),
    approve: rec('approve'),
    documentLocation: vi.fn(async (id: string) => `/ruta/${id}`),
    on: vi.fn(() => () => {}),
  } as unknown as ExpedienteFacade;
  const shown: string[] = [];
  const off = registerExpedienteIpc(ipc, svc, { showItemInFolder: (p) => shown.push(p) });
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a) as Promise<any>;
  return { handlers, calls, svc, shown, off, call };
}

const goodField = { conceptId: 'bruttolohn_jahr', variant: '', valor: '85400', evidence: [{ documentId: ID2, page: 1 }] };
const goodCase = { taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Ana' }] };

/** Una llamada válida y varias mal formadas por canal. */
const CASES: Array<{ ch: string; good: unknown[]; bad: unknown[][] }> = [
  { ch: CASE_CHANNELS.list, good: [], bad: [[1]] },
  { ch: CASE_CHANNELS.create, good: [goodCase], bad: [[{ ...goodCase, extra: 1 }], [{ ...goodCase, taxYear: 1999 }], [{ ...goodCase, jurisdiction: 'XX' }], [{ ...goodCase, persons: [{ role: 'hauptperson', label: 'x'.repeat(61) }] }], []] },
  { ch: CASE_CHANNELS.update, good: [ID, { taxYear: 2024 }], bad: [[ID.toUpperCase(), {}], ['../x', {}], [ID, { extra: true }], [ID, { persons: [{ slug: '../a', role: 'partner', label: 'x' }] }], [ID]] },
  { ch: CASE_CHANNELS.get, good: [ID], bad: [[ID.toUpperCase()], ['../../etc/passwd'], [ID, 'extra'], [{}]] },
  { ch: CASE_CHANNELS.concepts, good: [], bad: [['x']] },
  { ch: CASE_CHANNELS.importable, good: [], bad: [['x']] },
  { ch: CASE_CHANNELS.import, good: [ID, ID2], bad: [[ID, ID2.toUpperCase()], [ID, '../x'], [ID]] },
  { ch: CASE_CHANNELS.setDocument, good: [ID, { docType: 'quittung', status: 'confirmado' }], bad: [[ID, { docType: 'otro' }], [ID, { status: 'capturado' }], [ID, { extra: 1 }], [ID.toUpperCase(), {}]] },
  {
    ch: CASE_CHANNELS.saveField,
    good: [ID, goodField],
    bad: [
      [ID.toUpperCase(), goodField],
      [`${ID}/../x`, goodField],
      [ID, { ...goodField, extra: 1 }],
      [ID, { ...goodField, valor: 'x'.repeat(10_000) }],
      [ID, { ...goodField, evidence: Array.from({ length: 21 }, () => ({ documentId: ID2, page: 0 })) }],
      [ID, { ...goodField, evidence: [{ documentId: ID2, page: -1 }] }],
      [ID, { ...goodField, evidence: [{ documentId: ID2, page: 10_000 }] }],
      [ID, { ...goodField, evidence: [{ documentId: 'no-uuid', page: 1 }] }],
      [ID, { ...goodField, valor: 5 }],
    ],
  },
  { ch: CASE_CHANNELS.deleteField, good: [ID], bad: [[ID.toUpperCase()], ['x']] },
  { ch: CASE_CHANNELS.fieldHistory, good: [ID], bad: [[ID.toUpperCase()], [null]] },
  { ch: CASE_CHANNELS.approve, good: [ID, 3], bad: [[ID, -1], [ID, 1.5], [ID, '3'], [ID.toUpperCase(), 3]] },
  { ch: CASE_CHANNELS.showDocument, good: [ID], bad: [[ID.toUpperCase()], ['../../x']] },
];

afterEach(() => vi.restoreAllMocks());

describe('registerExpedienteIpc', () => {
  it('cubre todos los canales de petición', () => {
    const { handlers } = harness();
    const expected = Object.values(CASE_CHANNELS).filter((c) => c !== CASE_CHANNELS.event);
    expect([...handlers.keys()].sort()).toEqual([...expected].sort());
    expect(CASES.map((c) => c.ch).sort()).toEqual([...expected].sort());
  });

  for (const { ch, good, bad } of CASES) {
    describe(ch, () => {
      it('una llamada válida devuelve { ok: true, value }', async () => {
        const h = harness();
        const res = await h.call(ch, ...good);
        expect(res.ok).toBe(true);
        expect(res).toHaveProperty('value');
      });
      it.each(bad.map((a, i) => [i, a] as const))('argumentos mal formados #%i no llegan al servicio', async (_i, args) => {
        const h = harness();
        const res = await h.call(ch, ...args);
        expect(res).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
        expect(h.calls).toEqual([]);
        expect(h.svc.documentLocation).not.toHaveBeenCalled();
      });
    });
  }

  it('pasa al servicio los argumentos validados', async () => {
    const h = harness();
    await h.call(CASE_CHANNELS.saveField, ID, goodField);
    expect(h.calls).toEqual([['saveField', [ID, goodField]]]);
  });

  it('show-document entrega al explorador la ruta del servicio', async () => {
    const h = harness();
    const res = await h.call(CASE_CHANNELS.showDocument, ID);
    expect(res).toEqual({ ok: true, value: undefined });
    expect(h.shown).toEqual([`/ruta/${ID}`]);
  });

  it('convierte un ExpedienteError en { ok: false, error } con código, mensaje y detalles', async () => {
    const h = harness();
    (h.svc.updateCase as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new ExpedienteError('person_in_use', 'La persona tiene campos.', { fieldIds: [ID2] });
    });
    const res = await h.call(CASE_CHANNELS.update, ID, { taxYear: 2024 });
    expect(res).toEqual({ ok: false, error: { code: 'person_in_use', message: 'La persona tiene campos.', details: { fieldIds: [ID2] } } });
  });

  it('también convierte rechazos asíncronos', async () => {
    const h = harness();
    (h.svc.importPackage as ReturnType<typeof vi.fn>).mockRejectedValue(new ExpedienteError('package_incomplete', 'Falta el recibo.'));
    const res = await h.call(CASE_CHANNELS.import, ID, ID2);
    expect(res).toEqual({ ok: false, error: { code: 'package_incomplete', message: 'Falta el recibo.' } });
  });

  it('un error genérico da storage_error sin filtrar su mensaje ni a la consola', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    (h.svc.getCase as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('SQLITE_ERROR en /Users/ana/secreto.db');
    });
    const res = await h.call(CASE_CHANNELS.get, ID);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('storage_error');
    expect(JSON.stringify(res)).not.toMatch(/SQLITE|secreto|Users/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SQLITE|secreto|Users/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('reenvía los eventos del servicio y el cancelador lo quita todo', () => {
    const handlers = new Map<string, unknown>();
    const ipc: IpcMainLike = { handle: (c, f) => void handlers.set(c, f), removeHandler: (c) => void handlers.delete(c) };
    let listener: ((e: unknown) => void) | undefined;
    const unsub = vi.fn();
    const svc = { on: (cb: (e: unknown) => void) => ((listener = cb), unsub) } as unknown as ExpedienteFacade;
    const sent: Array<[string, unknown]> = [];
    const off = registerExpedienteIpc(ipc, svc, { showItemInFolder: () => {}, emit: (c, p) => sent.push([c, p]) });
    listener!({ type: 'case-changed', caseId: ID, revision: 2 });
    expect(sent).toEqual([[CASE_CHANNELS.event, { type: 'case-changed', caseId: ID, revision: 2 }]]);
    off();
    expect(handlers.size).toBe(0);
    expect(unsub).toHaveBeenCalled();
  });

  it('el cancelador quita todos los manejadores', () => {
    const h = harness();
    expect(h.handlers.size).toBeGreaterThan(0);
    h.off();
    expect(h.handlers.size).toBe(0);
  });
});
