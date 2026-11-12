import { afterEach, describe, expect, it } from 'vitest';
import { ExpedienteError } from '../index.js';
import { approvable, closeAll, JSON_, PDF, writePackage } from './fixtures.js';

afterEach(closeAll);

type Harness = Awaited<ReturnType<typeof approvable>>;

/**
 * Tabla de operaciones de escritura sobre un expediente (criterio 7). Para añadir una operación nueva de la API,
 * añade una fila: `prepare` deja el estado inicial (antes de aprobar) y `act` ejecuta la operación.
 */
const WRITES: Array<{ name: string; prepare?: (h: Harness) => Promise<void> | void; act: (h: Harness) => Promise<unknown> | unknown }> = [
  { name: 'updateCase: año fiscal', act: (h) => h.svc.updateCase(h.caseId, { taxYear: 2024 }) },
  { name: 'updateCase: cantón', act: (h) => h.svc.updateCase(h.caseId, { jurisdiction: 'BE' }) },
  {
    name: 'updateCase: alta de persona',
    act: (h) =>
      h.svc.updateCase(h.caseId, {
        persons: [
          { slug: 'hauptperson', role: 'hauptperson', label: 'Ana' },
          { role: 'partner', label: 'Beat' },
        ],
      }),
  },
  {
    name: 'updateCase: baja de persona',
    prepare: (h) => {
      h.svc.updateCase(h.caseId, {
        persons: [
          { slug: 'hauptperson', role: 'hauptperson', label: 'Ana' },
          { role: 'kind', label: 'Kim' },
        ],
      });
    },
    act: (h) => h.svc.updateCase(h.caseId, { persons: [{ slug: 'hauptperson', role: 'hauptperson', label: 'Ana' }] }),
  },
  { name: 'updateCase: cambio de rótulo de persona', act: (h) => h.svc.updateCase(h.caseId, { persons: [{ slug: 'hauptperson', role: 'hauptperson', label: 'Ana María' }] }) },
  {
    name: 'importPackage con un documento nuevo',
    act: (h) => h.svc.importPackage(h.caseId, writePackage(h.inboxDir, [{ name: 'datos.json', mime: 'application/json', body: JSON_ }]).packageId),
  },
  { name: 'setDocument: cambio de tipo', act: (h) => h.svc.setDocument(h.png, { docType: 'bankbeleg' }) },
  { name: 'setDocument: confirmado → pendiente_de_revision', act: (h) => h.svc.setDocument(h.png, { status: 'pendiente_de_revision' }) },
  { name: 'setDocument: confirmado → descartado', act: (h) => h.svc.setDocument(h.png, { status: 'descartado' }) },
  {
    name: 'setDocument: descartado → pendiente_de_revision',
    prepare: (h) => {
      h.svc.setDocument(h.png, { status: 'descartado' });
    },
    act: (h) => h.svc.setDocument(h.png, { status: 'pendiente_de_revision' }),
  },
  { name: 'saveField: alta', act: (h) => h.svc.saveField(h.caseId, { conceptId: 'nettolohn_jahr', variant: '', valor: '70000', evidence: [] }) },
  {
    name: 'saveField: corrección del valor',
    act: (h) => {
      const f = h.svc.getCase(h.caseId).fields[0]!;
      return h.svc.saveField(h.caseId, { fieldId: f.fieldId, conceptId: f.conceptId, variant: f.variant, valor: '85500', evidence: f.evidence.map((e) => ({ ...e })) });
    },
  },
  {
    name: 'saveField: corrección solo de la evidencia',
    act: (h) => {
      const f = h.svc.getCase(h.caseId).fields[0]!;
      return h.svc.saveField(h.caseId, { fieldId: f.fieldId, conceptId: f.conceptId, variant: f.variant, valor: String(f.valor), evidence: [] });
    },
  },
  { name: 'deleteField', act: (h) => h.svc.deleteField(h.svc.getCase(h.caseId).fields[0]!.fieldId) },
  { name: 'proposeField', act: (h) => h.svc.proposeField(h.caseId, { conceptId: 'nettolohn_jahr', variant: '', valor: '70000', evidence: [], origin: 'modelo' }) },
];

describe('invalidación de la aprobación (criterio 7)', () => {
  it.each(WRITES.map((w) => [w.name, w] as const))('%s saca al expediente de «aprobado» y approvedDeclaration lanza approval_stale', async (_name, w) => {
    const h = await approvable();
    await w.prepare?.(h);
    h.svc.approve(h.caseId, h.svc.getCase(h.caseId).revision);
    expect(h.svc.getCase(h.caseId).status).toBe('aprobado');
    expect(h.svc.approvedDeclaration(h.caseId).declaration).toBeDefined();

    await w.act(h);

    const view = h.svc.getCase(h.caseId);
    expect(view.status).not.toBe('aprobado');
    expect(view.lastApproval).toBeDefined(); // la aprobación vieja sigue ahí, pero ya no es vigente
    let err: unknown;
    try {
      h.svc.approvedDeclaration(h.caseId);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpedienteError);
    expect((err as ExpedienteError).code).toBe('approval_stale');
  });

  it('importPackage sin documentos nuevos no invalida la aprobación', async () => {
    const h = await approvable();
    h.svc.approve(h.caseId, h.svc.getCase(h.caseId).revision);
    const again = writePackage(h.inboxDir, [{ name: 'otra.pdf', mime: 'application/pdf', body: PDF }]);
    const res = await h.svc.importPackage(h.caseId, again.packageId);
    expect(res.documents.every((d) => d.outcome === 'existente')).toBe(true);
    expect(h.svc.getCase(h.caseId).status).toBe('aprobado');
    expect(h.svc.approvedDeclaration(h.caseId).declaration).toBeDefined();
  });

  it('setDocument pendiente_de_revision → confirmado: solo es posible desde un estado ya obsoleto, pero también sube la revisión', async () => {
    // Un documento pendiente bloquea la aprobación, así que esta transición nunca parte de «aprobado» (no hay fila en la tabla).
    const h = await approvable();
    h.svc.setDocument(h.png, { status: 'pendiente_de_revision' });
    const r = h.svc.getCase(h.caseId).revision;
    h.svc.setDocument(h.png, { status: 'confirmado' });
    expect(h.svc.getCase(h.caseId).revision).toBe(r + 1);
  });

  it('una operación que no cambia nada tampoco invalida (saveField idéntico)', async () => {
    const h = await approvable();
    h.svc.approve(h.caseId, h.svc.getCase(h.caseId).revision);
    const f = h.svc.getCase(h.caseId).fields[0]!;
    h.svc.saveField(h.caseId, { fieldId: f.fieldId, conceptId: f.conceptId, variant: f.variant, valor: String(f.valor), evidence: f.evidence.map((e) => ({ ...e })) });
    expect(h.svc.getCase(h.caseId).status).toBe('aprobado');
  });
});
