import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpedienteError, ExpedienteService, type CaseInput, type ExpedienteEvent } from '../index.js';
import { openRaw } from '../storage/__tests__/helpers.js';

const open: ExpedienteService[] = [];
let tick = 0;
async function mk(dataDir = mkdtempSync(join(tmpdir(), 'fodibo-exp-'))) {
  const svc = await ExpedienteService.open({ dataDir, inboxDir: join(dataDir, 'inbox'), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  open.push(svc);
  return { svc, dataDir, dbDir: join(dataDir, 'expediente') };
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const family: CaseInput = {
  taxYear: 2025,
  jurisdiction: 'ZH',
  persons: [
    { role: 'hauptperson', label: 'Ana' },
    { role: 'partner', label: 'Beto' },
    { role: 'kind', label: 'Cleo' },
    { role: 'kind', label: 'Dani' },
  ],
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ExpedienteError).code;
  }
  return 'no lanzó';
};

describe('createCase / listCases', () => {
  it('crea un expediente con titular, pareja y dos hijos', async () => {
    const { svc, dbDir } = await mk();
    const c = svc.createCase(family);
    expect(c.persons.map((p) => p.slug)).toEqual(['hauptperson', 'partner', 'kind_1', 'kind_2']);
    expect(c.revision).toBe(0);
    expect(svc.getCase(c.caseId)).toEqual(c);
    expect(svc.listCases()).toEqual([
      { caseId: c.caseId, taxYear: 2025, jurisdiction: 'ZH', revision: 0, createdAt: c.createdAt, hauptpersonLabel: 'Ana' },
    ]);
    const raw = openRaw(dbDir);
    const rows = raw.prepare('SELECT revision, entity, action, actor, before FROM changes WHERE entity = ?').all('case');
    raw.close();
    expect(rows).toEqual([{ revision: 0, entity: 'case', action: 'create', actor: 'usuario:local', before: null }]);
  });

  it.each([
    ['dos titulares', { ...family, persons: [{ role: 'hauptperson', label: 'A' }, { role: 'hauptperson', label: 'B' }] }],
    ['ningún titular', { ...family, persons: [{ role: 'partner', label: 'A' }] }],
    ['dos parejas', { ...family, persons: [{ role: 'hauptperson', label: 'A' }, { role: 'partner', label: 'B' }, { role: 'partner', label: 'C' }] }],
    ['año 1999', { ...family, taxYear: 1999 }],
    ['año 2101', { ...family, taxYear: 2101 }],
    ['cantón desconocido', { ...family, jurisdiction: 'XX' }],
    ['rótulo vacío', { ...family, persons: [{ role: 'hauptperson', label: '' }] }],
    ['rótulo largo', { ...family, persons: [{ role: 'hauptperson', label: 'x'.repeat(61) }] }],
  ])('rechaza %s', async (_n, input) => {
    const { svc } = await mk();
    expect(code(() => svc.createCase(input as CaseInput))).toBe('invalid_input');
    expect(svc.listCases()).toEqual([]);
  });

  it('getCase de un id desconocido lanza not_found', async () => {
    const { svc } = await mk();
    expect(code(() => svc.getCase('nope'))).toBe('not_found');
    expect(code(() => svc.updateCase('nope', { taxYear: 2024 }))).toBe('not_found');
  });
});

describe('updateCase', () => {
  it('incrementa la revisión en 1, emite case-changed y registra before/after', async () => {
    const { svc, dbDir } = await mk();
    const c = svc.createCase(family);
    const events: ExpedienteEvent[] = [];
    svc.on((e) => events.push(e));
    const u = svc.updateCase(c.caseId, {
      taxYear: 2024,
      persons: c.persons.map((p) => ({ slug: p.slug, role: p.role, label: p.slug === 'partner' ? 'Berta' : p.label })),
    });
    expect(u.revision).toBe(1);
    expect(u.taxYear).toBe(2024);
    expect(u.persons.find((p) => p.slug === 'partner')?.label).toBe('Berta');
    expect(events).toEqual([{ type: 'case-changed', caseId: c.caseId, revision: 1 }]);
    const raw = openRaw(dbDir);
    const rows = raw.prepare('SELECT revision, entity, action, before, after FROM changes WHERE revision = 1 ORDER BY change_id').all() as any[];
    raw.close();
    expect(rows.map((r) => [r.entity, r.action])).toEqual([['case', 'update'], ['person', 'update']]);
    expect(JSON.parse(rows[0].before)).toEqual({ tax_year: 2025, jurisdiction: 'ZH' });
    expect(JSON.parse(rows[0].after)).toEqual({ tax_year: 2024, jurisdiction: 'ZH' });
    expect(JSON.parse(rows[1].before).label).toBe('Beto');
    expect(JSON.parse(rows[1].after).label).toBe('Berta');
  });

  it('sin cambios reales no sube la revisión ni emite', async () => {
    const { svc } = await mk();
    const c = svc.createCase(family);
    const events: ExpedienteEvent[] = [];
    svc.on((e) => events.push(e));
    expect(svc.updateCase(c.caseId, { taxYear: 2025 }).revision).toBe(0);
    expect(events).toEqual([]);
  });

  it('baja de kind_2 y alta de otro hijo da kind_3 (el slug no se reutiliza)', async () => {
    const { svc } = await mk();
    const c = svc.createCase(family);
    const keep = c.persons.filter((p) => p.slug !== 'kind_2').map((p) => ({ slug: p.slug, role: p.role, label: p.label }));
    const u = svc.updateCase(c.caseId, { persons: [...keep, { role: 'kind', label: 'Eli' }] });
    expect(u.persons.map((p) => p.slug)).toEqual(['hauptperson', 'partner', 'kind_1', 'kind_3']);
    expect(u.revision).toBe(1);
    // Baja del último y alta: tampoco reutiliza el ordinal.
    const u2 = svc.updateCase(c.caseId, { persons: [...keep, { role: 'kind', label: 'Fer' }] });
    expect(u2.persons.map((p) => p.slug)).toEqual(['hauptperson', 'partner', 'kind_1', 'kind_4']);
  });

  it('rechaza listas de personas no válidas sin cambiar nada', async () => {
    const { svc } = await mk();
    const c = svc.createCase(family);
    expect(code(() => svc.updateCase(c.caseId, { persons: [{ slug: 'partner', role: 'partner', label: 'x' }] }))).toBe('invalid_input');
    expect(code(() => svc.updateCase(c.caseId, { persons: [{ slug: 'zzz', role: 'kind', label: 'x' }] }))).toBe('invalid_input');
    expect(code(() => svc.updateCase(c.caseId, { persons: [{ slug: 'hauptperson', role: 'kind', label: 'x' }] }))).toBe('invalid_input');
    expect(svc.getCase(c.caseId)).toEqual(c);
  });

  it('person_in_use: quitar una persona con campos lanza el error y no cambia nada', async () => {
    const { svc, dbDir } = await mk();
    const c = svc.createCase(family);
    const raw = openRaw(dbDir);
    raw
      .prepare(
        `INSERT INTO fields (field_id, case_id, concept_id, variant, tipo, valor, moneda, origin, status, updated_at)
         VALUES ('f1', ?, 'krankenkasse_praemie', 'partner', 'amount', '100.00', 'CHF', 'usuario', 'pendiente', '2026-01-01T00:00:00.000Z')`,
      )
      .run(c.caseId);
    raw.close();
    const unchanged = svc.getCase(c.caseId);
    const events: ExpedienteEvent[] = [];
    svc.on((e) => events.push(e));
    const keep = c.persons.filter((p) => p.slug !== 'partner').map((p) => ({ slug: p.slug, role: p.role, label: p.label }));
    try {
      svc.updateCase(c.caseId, { taxYear: 2024, persons: keep });
      expect.unreachable();
    } catch (e) {
      expect((e as ExpedienteError).code).toBe('person_in_use');
      expect((e as ExpedienteError).details).toEqual({ fieldIds: ['f1'] });
    }
    expect(svc.getCase(c.caseId)).toEqual(unchanged);
    expect(events).toEqual([]);
  });
});

describe('eventos y cola', () => {
  it('un listener que lanza no rompe el servicio ni a los demás; on devuelve la baja', async () => {
    const { svc } = await mk();
    const c = svc.createCase(family);
    const got: number[] = [];
    svc.on(() => {
      throw new Error('boom');
    });
    const off = svc.on((e) => got.push(e.revision));
    expect(svc.updateCase(c.caseId, { taxYear: 2024 }).revision).toBe(1);
    off();
    svc.updateCase(c.caseId, { taxYear: 2023 });
    expect(got).toEqual([1]);
  });

  it('la cola serializa y sigue funcionando tras una operación rechazada', async () => {
    const { svc } = await mk();
    const order: string[] = [];
    const a = svc.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('a');
    });
    const b = svc.enqueue(async () => {
      order.push('b');
      throw new Error('fallo');
    });
    const c = svc.enqueue(async () => {
      order.push('c');
      return 7;
    });
    await a;
    await expect(b).rejects.toThrow('fallo');
    expect(await c).toBe(7);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('reabrir el mismo dataDir conserva los expedientes', async () => {
    const { svc, dataDir } = await mk();
    const c = svc.createCase(family);
    svc.close();
    open.pop();
    const again = (await mk(dataDir)).svc;
    expect(again.getCase(c.caseId)).toEqual(c);
  });
});
