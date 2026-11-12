import { afterEach, describe, expect, it } from 'vitest';
import { ExpedienteError } from '../index.js';
import { closeAll, mk, three, writePackage } from './fixtures.js';

afterEach(closeAll);

const catchErr = (fn: () => unknown): ExpedienteError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExpedienteError) return e;
    throw e;
  }
  throw new Error('no lanzó');
};

async function withDocs() {
  const h = await mk();
  const pkg = writePackage(h.inboxDir, three.slice(0, 2));
  const res = await h.svc.importPackage(h.caseId, pkg.packageId);
  const [pdf, png] = res.documents.map((d) => d.documentId) as [string, string];
  return { ...h, pkg, pdf, png };
}
const doc = (h: Awaited<ReturnType<typeof withDocs>>, id: string) => h.svc.getCase(h.caseId).documents.find((d) => d.documentId === id)!;

describe('documentos', () => {
  it('getCase lista los documentos importados', async () => {
    const h = await withDocs();
    const docs = h.svc.getCase(h.caseId).documents;
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.documentId === h.pdf)).toMatchObject({
      mime: 'application/pdf',
      originalName: 'Lohnausweis.pdf',
      docType: null,
      status: 'pendiente_de_revision',
      sourceDevice: 'iPhone de Ana',
    });
  });

  it('confirmado sin tipo: invalid_transition; con tipo en el mismo parche, bien', async () => {
    const h = await withDocs();
    const rev = h.svc.getCase(h.caseId).revision;
    expect(catchErr(() => h.svc.setDocument(h.pdf, { status: 'confirmado' })).code).toBe('invalid_transition');
    expect(h.svc.getCase(h.caseId).revision).toBe(rev);
    h.svc.setDocument(h.pdf, { docType: 'lohnausweis', status: 'confirmado' });
    expect(doc(h, h.pdf)).toMatchObject({ docType: 'lohnausweis', status: 'confirmado' });
    expect(h.svc.getCase(h.caseId).revision).toBe(rev + 1);
  });

  it('asignar solo el tipo y luego confirmar; reabrir', async () => {
    const h = await withDocs();
    h.svc.setDocument(h.png, { docType: 'quittung' });
    expect(doc(h, h.png)).toMatchObject({ docType: 'quittung', status: 'pendiente_de_revision' });
    h.svc.setDocument(h.png, { status: 'confirmado' });
    h.svc.setDocument(h.png, { status: 'pendiente_de_revision' });
    expect(doc(h, h.png).status).toBe('pendiente_de_revision');
  });

  it('un parche sin cambios no sube la revisión', async () => {
    const h = await withDocs();
    const rev = h.svc.getCase(h.caseId).revision;
    h.svc.setDocument(h.pdf, { status: 'pendiente_de_revision' });
    h.svc.setDocument(h.pdf, {});
    expect(h.svc.getCase(h.caseId).revision).toBe(rev);
  });

  it('descartar un documento citado: invalid_transition con los fieldIds', async () => {
    const h = await withDocs();
    h.svc.saveField(h.caseId, { conceptId: 'bruttolohn_jahr', variant: '', valor: '1', evidence: [{ documentId: h.pdf, page: 1 }] });
    h.svc.saveField(h.caseId, { conceptId: 'nachname', variant: '', valor: 'X', evidence: [{ documentId: h.pdf, page: 2 }] });
    const ids = h.svc.getCase(h.caseId).fields.map((f) => f.fieldId).sort();
    const e = catchErr(() => h.svc.setDocument(h.pdf, { status: 'descartado' }));
    expect(e.code).toBe('invalid_transition');
    expect(e.details).toEqual({ fieldIds: ids });
    expect(doc(h, h.pdf).status).toBe('pendiente_de_revision');
  });

  it('descartado → pendiente_de_revision, y descartado → confirmado no está permitido', async () => {
    const h = await withDocs();
    h.svc.setDocument(h.png, { docType: 'sonstiges' });
    h.svc.setDocument(h.png, { status: 'descartado' });
    expect(catchErr(() => h.svc.setDocument(h.png, { status: 'confirmado' })).code).toBe('invalid_transition');
    h.svc.setDocument(h.png, { status: 'pendiente_de_revision' });
    expect(doc(h, h.png).status).toBe('pendiente_de_revision');
  });

  it('reimportar un descartado no cambia su estado', async () => {
    const h = await withDocs();
    h.svc.setDocument(h.png, { status: 'descartado' });
    const again = writePackage(h.inboxDir, [three[1]!]);
    const res = await h.svc.importPackage(h.caseId, again.packageId);
    expect(res.documents[0]).toMatchObject({ documentId: h.png, outcome: 'existente' });
    expect(doc(h, h.png).status).toBe('descartado');
  });

  it('entradas no válidas', async () => {
    const h = await withDocs();
    expect(catchErr(() => h.svc.setDocument('00000000-0000-4000-8000-000000000000', { status: 'confirmado' })).code).toBe('not_found');
    expect(catchErr(() => h.svc.setDocument(h.pdf, { docType: 'otro' as never })).code).toBe('invalid_input');
    expect(catchErr(() => h.svc.setDocument(h.pdf, { status: 'capturado' as never })).code).toBe('invalid_input');
  });

  it('registra la entrada en changes con el id del documento', async () => {
    const h = await withDocs();
    h.svc.setDocument(h.pdf, { docType: 'lohnausweis' });
    const { openRaw } = await import('../storage/__tests__/helpers.js');
    const raw = openRaw(h.dbDir);
    const row = raw.prepare("SELECT * FROM changes WHERE entity = 'document' AND action = 'update'").get() as Record<string, string>;
    raw.close();
    expect(row.entity_id).toBe(h.pdf);
    expect(JSON.parse(row.before!)).toEqual({ doc_type: null, status: 'pendiente_de_revision' });
    expect(JSON.parse(row.after!)).toEqual({ doc_type: 'lohnausweis', status: 'pendiente_de_revision' });
  });
});
