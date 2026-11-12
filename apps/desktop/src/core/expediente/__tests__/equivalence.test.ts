import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONCEPTS, loadDeclaration, resolveFromCatalog } from '../../agent/index.js';
import { portalDeclaration, portalExpectations } from '../../agent/__tests__/portal-fields.js';
import { ExpedienteService } from '../index.js';
import { seedFromDeclaration } from '../seed.js';

const open: ExpedienteService[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function seeded() {
  const dataDir = mkdtempSync(join(tmpdir(), 'fodibo-eq-'));
  const inboxDir = join(dataDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const svc = await ExpedienteService.open({ dataDir, inboxDir });
  open.push(svc);
  const { caseId } = await seedFromDeclaration(svc, portalDeclaration(), { taxYear: 2025, jurisdiction: 'ZH', label: 'Anna' });
  return { svc, caseId };
}

describe('equivalencia con el prototipo', () => {
  it('la proyección aprobada es estrictamente igual a loadDeclaration(declaracion.json)', async () => {
    const { svc, caseId } = await seeded();
    const projected = svc.approvedDeclaration(caseId).declaration;
    const original = loadDeclaration(portalDeclaration());
    expect(projected).toStrictEqual(original);
    expect(projected).toHaveProperty('krankenkasse_praemie_hauptperson');
    expect(projected).toHaveProperty('krankenkasse_praemie_familie');
  });

  it('con esa proyección, resolveFromCatalog resuelve los 17 campos como indica esperado.json', async () => {
    const { svc, caseId } = await seeded();
    const declaration = svc.approvedDeclaration(caseId).declaration;
    const { expected, byStep } = portalExpectations();
    let checked = 0;
    for (const [n, fields] of byStep) {
      const r = resolveFromCatalog({ index: n, total: 2, title: 'P', isSummary: false, fields, errors: [] }, declaration, CONCEPTS);
      for (const field of fields) {
        const exp = expected.get(`${n}/${field.label}`)!.expected;
        const got = r.answer[field.field_id] as Record<string, unknown>;
        expect(r.resolved.has(field.field_id), field.label).toBe(true);
        if ('source' in exp) expect(got, field.label).toEqual({ source: exp.source, ...(exp.option ? { option: exp.option } : {}) });
        else if ('pending' in exp) expect(got, field.label).toMatchObject({ pending: expect.any(String) });
        else expect(got, field.label).toEqual({ skip: true });
        checked++;
      }
    }
    expect(checked).toBe(17);
  });
});
