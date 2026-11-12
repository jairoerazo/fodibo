import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../agent/index.js';
import { ExpedienteError, ExpedienteService } from '../index.js';
import { checkVocabulary, keyFor, splitKey } from '../fields.js';
import { closeAll, mk, open, three, writePackage } from './fixtures.js';

afterEach(closeAll);

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExpedienteError) return e.code;
    throw e;
  }
  return undefined;
};

/** Expediente con un PDF y un PNG importados; devuelve los ids de ambos documentos. */
async function withDocs() {
  const h = await mk();
  const pkg = writePackage(h.inboxDir, three.slice(0, 2));
  const res = await h.svc.importPackage(h.caseId, pkg.packageId);
  const [pdf, png] = res.documents.map((d) => d.documentId) as [string, string];
  return { ...h, pdf, png };
}
const field = (svc: ExpedienteService, caseId: string, key: string) => svc.getCase(caseId).fields.find((f) => f.key === key);

describe('vocabulario', () => {
  const slugs = ['hauptperson', 'partner', 'kind_1'];
  it('concepto fuera del catálogo: invalid_input', () => {
    expect(code(() => checkVocabulary(CONCEPTS, slugs, 'no_existe', ''))).toBe('invalid_input');
  });
  it('variante en un concepto sin variantes: invalid_input', () => {
    expect(code(() => checkVocabulary(CONCEPTS, slugs, 'bruttolohn_jahr', 'hauptperson'))).toBe('invalid_input');
    expect(checkVocabulary(CONCEPTS, slugs, 'bruttolohn_jahr', '').id).toBe('bruttolohn_jahr');
  });
  it('krankenkasse_praemie exige variante existente', () => {
    expect(code(() => checkVocabulary(CONCEPTS, slugs, 'krankenkasse_praemie', ''))).toBe('invalid_input');
    expect(code(() => checkVocabulary(CONCEPTS, slugs, 'krankenkasse_praemie', 'kind_9'))).toBe('invalid_input');
    expect(code(() => checkVocabulary(CONCEPTS, slugs, 'krankenkasse_praemie', 'kind_1'))).toBeUndefined();
  });
  it('familie es válida', () => {
    expect(checkVocabulary(CONCEPTS, slugs, 'krankenkasse_praemie', 'familie').id).toBe('krankenkasse_praemie');
  });
  it('splitKey(keyFor(c, v)) = {c, v} para todo el catálogo', () => {
    expect(keyFor('bruttolohn_jahr', '')).toBe('bruttolohn_jahr');
    expect(keyFor('krankenkasse_praemie', 'familie')).toBe('krankenkasse_praemie_familie');
    for (const c of CONCEPTS) {
      const variants = c.variants ? ['', 'hauptperson', 'partner', 'kind_1', 'familie'] : [''];
      for (const v of variants) expect(splitKey(keyFor(c.id, v), CONCEPTS)).toEqual({ conceptId: c.id, variant: v });
    }
    expect(splitKey('desconocido', CONCEPTS)).toBeUndefined();
    expect(splitKey('bruttolohn_jahr_partner', CONCEPTS)).toBeUndefined();
    expect(splitKey('krankenkasse_praemie_', CONCEPTS)).toBeUndefined();
  });
});

describe('saveField', () => {
  it('alta, normaliza el valor y deja el campo confirmado con origen usuario', async () => {
    const { svc, caseId, pdf } = await withDocs();
    const events: number[] = [];
    svc.on((e) => events.push(e.revision));
    const v = svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: "85'400", evidence: [{ documentId: pdf, page: 3 }] });
    const f = field(svc, caseId, 'bruttolohn_jahr')!;
    expect(f).toMatchObject({ conceptId: 'bruttolohn_jahr', variant: '', tipo: 'amount', valor: '85400.00', moneda: 'CHF', origin: 'usuario', status: 'confirmado' });
    expect(f.evidence).toEqual([{ documentId: pdf, page: 3 }]);
    expect(v.revision).toBe(2);
    expect(events).toEqual([2]);
  });

  it('un campo booleano conserva su tipo en la vista', async () => {
    // El catálogo actual no tiene conceptos booleanos: se abre el servicio con uno propio.
    const dataDir = mkdtempSync(join(tmpdir(), 'fodibo-bool-'));
    const svc = await ExpedienteService.open({ dataDir, inboxDir: join(dataDir, 'inbox'), concepts: [{ id: 'verheiratet', tipo: 'boolean', labels: ['Verheiratet'] }] });
    open.push(svc);
    const caseId = svc.createCase({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Ana' }] }).caseId;
    svc.saveField(caseId, { conceptId: 'verheiratet', variant: '', valor: false, evidence: [] });
    expect(field(svc, caseId, 'verheiratet')).toMatchObject({ tipo: 'boolean', valor: false, moneda: null });
    const id = field(svc, caseId, 'verheiratet')!.fieldId;
    svc.saveField(caseId, { fieldId: id, conceptId: 'verheiratet', variant: '', valor: true, evidence: [] });
    expect(field(svc, caseId, 'verheiratet')!.valor).toBe(true);
    expect(svc.fieldHistory(id)[1]!.before).toMatchObject({ valor: false });
  });

  it('alta repetida de la misma combinación: invalid_input', async () => {
    const { svc, caseId } = await withDocs();
    svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '1', evidence: [] });
    expect(code(() => svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '2', evidence: [] }))).toBe('invalid_input');
  });

  it('corregir dos veces deja tres entradas en el historial', async () => {
    const { svc, caseId, pdf } = await withDocs();
    svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '100', evidence: [] });
    const id = field(svc, caseId, 'bruttolohn_jahr')!.fieldId;
    svc.saveField(caseId, { fieldId: id, conceptId: 'bruttolohn_jahr', variant: '', valor: '200,5', evidence: [{ documentId: pdf, page: 1 }] });
    svc.saveField(caseId, { fieldId: id, conceptId: 'bruttolohn_jahr', variant: '', valor: '300', evidence: [] });
    const h = svc.fieldHistory(id);
    const at = h.map((e) => e.at);
    expect([...at].sort()).toEqual(at);
    expect(h.map((e) => [e.action, e.actor, e.revision])).toEqual([
      ['create', 'usuario:local', 2],
      ['update', 'usuario:local', 3],
      ['update', 'usuario:local', 4],
    ]);
    const state = (valor: string, evidence: unknown[]) => ({ tipo: 'amount', valor, moneda: 'CHF', origin: 'usuario', status: 'confirmado', evidence });
    expect(h[0]!.before).toBeNull();
    expect(h[0]!.after).toEqual(state('100.00', []));
    expect(h[1]!.before).toEqual(state('100.00', []));
    expect(h[1]!.after).toEqual(state('200.50', [{ documentId: pdf, page: 1 }]));
    expect(h[2]!.before).toEqual(state('200.50', [{ documentId: pdf, page: 1 }]));
    expect(h[2]!.after).toEqual(state('300.00', []));
  });

  it('guardar un campo idéntico no cambia la revisión ni emite evento', async () => {
    const { svc, caseId } = await withDocs();
    svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '100', evidence: [] });
    const id = field(svc, caseId, 'bruttolohn_jahr')!.fieldId;
    const rev = svc.getCase(caseId).revision;
    const events: number[] = [];
    svc.on((e) => events.push(e.revision));
    svc.saveField(caseId, { fieldId: id, conceptId: 'bruttolohn_jahr', variant: '', valor: '100.00', evidence: [] });
    expect(svc.getCase(caseId).revision).toBe(rev);
    expect(events).toEqual([]);
    expect(svc.fieldHistory(id)).toHaveLength(1);
  });

  it('confirmar sin cambios un campo propuesto por regla conserva el origen; corregirlo pasa a usuario', async () => {
    const { svc, caseId } = await withDocs();
    svc.proposeField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '100', evidence: [], origin: 'regla' });
    const p = field(svc, caseId, 'bruttolohn_jahr')!;
    expect(p).toMatchObject({ origin: 'regla', status: 'pendiente' });
    svc.saveField(caseId, { fieldId: p.fieldId, conceptId: 'bruttolohn_jahr', variant: '', valor: '100.00', evidence: [] });
    expect(field(svc, caseId, 'bruttolohn_jahr')).toMatchObject({ origin: 'regla', status: 'confirmado' });

    svc.proposeField(caseId, { conceptId: 'nachname', variant: '', valor: 'Muster', evidence: [], origin: 'modelo' });
    const q = field(svc, caseId, 'nachname')!;
    svc.saveField(caseId, { fieldId: q.fieldId, conceptId: 'nachname', variant: '', valor: 'Muster2', evidence: [] });
    expect(field(svc, caseId, 'nachname')).toMatchObject({ origin: 'usuario', status: 'confirmado' });
    expect(svc.fieldHistory(p.fieldId).map((e) => e.action)).toEqual(['create', 'update']);
  });

  it('un campo ya confirmado por usuario pierde el origen si lo era otro y cambia el valor, y no puede cambiar de clave', async () => {
    const { svc, caseId } = await withDocs();
    svc.saveField(caseId, { conceptId: 'nachname', variant: '', valor: 'A', evidence: [] });
    const id = field(svc, caseId, 'nachname')!.fieldId;
    expect(code(() => svc.saveField(caseId, { fieldId: id, conceptId: 'vorname', variant: '', valor: 'A', evidence: [] }))).toBe('invalid_input');
    expect(code(() => svc.saveField(caseId, { fieldId: '00000000-0000-4000-8000-000000000000', conceptId: 'nachname', variant: '', valor: 'A', evidence: [] }))).toBe('not_found');
  });

  it('valores no válidos: invalid_input y nada cambia', async () => {
    const { svc, caseId } = await withDocs();
    const rev = svc.getCase(caseId).revision;
    expect(code(() => svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: 'abc', evidence: [] }))).toBe('invalid_input');
    expect(code(() => svc.saveField(caseId, { conceptId: 'no_existe', variant: '', valor: 'x', evidence: [] }))).toBe('invalid_input');
    expect(code(() => svc.proposeField(caseId, { conceptId: 'nachname', variant: '', valor: 'x', evidence: [], origin: 'usuario' as never }))).toBe('invalid_input');
    expect(svc.getCase(caseId).revision).toBe(rev);
  });

  it('variantes: persona existente y familie', async () => {
    const { svc, caseId } = await withDocs();
    expect(code(() => svc.saveField(caseId, { conceptId: 'krankenkasse_praemie', variant: 'kind_9', valor: '1', evidence: [] }))).toBe('invalid_input');
    svc.saveField(caseId, { conceptId: 'krankenkasse_praemie', variant: 'hauptperson', valor: '1', evidence: [] });
    svc.saveField(caseId, { conceptId: 'krankenkasse_praemie', variant: 'familie', valor: '2', evidence: [] });
    expect(svc.getCase(caseId).fields.map((f) => f.key).sort()).toEqual(['krankenkasse_praemie_familie', 'krankenkasse_praemie_hauptperson']);
  });
});

describe('evidencia', () => {
  it('documento descartado o de otro expediente: invalid_input', async () => {
    const { svc, caseId, pdf, png, inboxDir } = await withDocs();
    svc.setDocument(png, { status: 'descartado' });
    const save = (e: Array<{ documentId: string; page: number }>) => () =>
      svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '1', evidence: e });
    expect(code(save([{ documentId: png, page: 0 }]))).toBe('invalid_input');
    const other = svc.createCase({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Bea' }] });
    const pkg = writePackage(inboxDir, [{ name: 'otro.pdf', mime: 'application/pdf', body: Buffer.from('%PDF-1.4\notro\n%%EOF\n') }]);
    const r = await svc.importPackage(other.caseId, pkg.packageId);
    expect(code(save([{ documentId: r.documents[0]!.documentId, page: 1 }]))).toBe('invalid_input');
    expect(code(save([{ documentId: '00000000-0000-4000-8000-000000000000', page: 0 }]))).toBe('invalid_input');
    expect(code(save([{ documentId: pdf, page: 1 }]))).toBeUndefined();
  });

  it('límites: duplicados, más de 20, página fuera de rango y página en no PDF', async () => {
    const { svc, caseId, pdf, png } = await withDocs();
    const save = (e: Array<{ documentId: string; page: number }>) => () =>
      svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '1', evidence: e });
    expect(code(save([{ documentId: pdf, page: 1 }, { documentId: pdf, page: 1 }]))).toBe('invalid_input');
    expect(code(save(Array.from({ length: 21 }, (_, i) => ({ documentId: pdf, page: i }))))).toBe('invalid_input');
    expect(code(save([{ documentId: pdf, page: 10000 }]))).toBe('invalid_input');
    expect(code(save([{ documentId: pdf, page: -1 }]))).toBe('invalid_input');
    expect(code(save([{ documentId: pdf, page: 1.5 }]))).toBe('invalid_input');
    expect(code(save([{ documentId: png, page: 1 }]))).toBe('invalid_input');
    expect(code(save(Array.from({ length: 20 }, (_, i) => ({ documentId: pdf, page: i }))))).toBeUndefined();
    expect(svc.getCase(caseId).fields[0]!.evidence).toHaveLength(20);
    const id = svc.getCase(caseId).fields[0]!.fieldId;
    expect(code(() => svc.saveField(caseId, { fieldId: id, conceptId: 'bruttolohn_jahr', variant: '', valor: '1', evidence: [{ documentId: png, page: 0 }, { documentId: pdf, page: 9999 }] }))).toBeUndefined();
  });
});

describe('deleteField', () => {
  it('borrar un campo conserva su historial', async () => {
    const { svc, caseId, pdf } = await withDocs();
    svc.saveField(caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '100', evidence: [{ documentId: pdf, page: 1 }] });
    const id = field(svc, caseId, 'bruttolohn_jahr')!.fieldId;
    const v = svc.deleteField(id);
    expect(v.fields).toEqual([]);
    expect(v.revision).toBe(3);
    const h = svc.fieldHistory(id);
    expect(h.map((e) => e.action)).toEqual(['create', 'delete']);
    expect(h[1]!.after).toBeNull();
    expect(h[1]!.before).toMatchObject({ valor: '100.00', evidence: [{ documentId: pdf, page: 1 }] });
    expect(code(() => svc.deleteField(id))).toBe('not_found');
    // y el documento vuelve a poder descartarse
    expect(code(() => svc.setDocument(pdf, { status: 'descartado' }))).toBeUndefined();
  });

  it('un campo borrado permite volver a dar de alta la combinación', async () => {
    const { svc, caseId } = await withDocs();
    svc.saveField(caseId, { conceptId: 'nachname', variant: '', valor: 'A', evidence: [] });
    svc.deleteField(field(svc, caseId, 'nachname')!.fieldId);
    svc.saveField(caseId, { conceptId: 'nachname', variant: '', valor: 'B', evidence: [] });
    expect(field(svc, caseId, 'nachname')!.valor).toBe('B');
  });
});

describe('listConcepts', () => {
  it('expone el catálogo', async () => {
    const { svc } = await withDocs();
    const list = svc.listConcepts();
    expect(list).toHaveLength(CONCEPTS.length);
    expect(list.find((c) => c.id === 'krankenkasse_praemie')).toMatchObject({ tipo: 'amount', variants: true });
    expect(list.find((c) => c.id === 'bruttolohn_jahr')!.variants).toBe(false);
  });
});
