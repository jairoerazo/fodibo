import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../agent/index.js';
import { caseStatus, type StatusInput } from '../status.js';

const D1 = 'd1';
const base = (): StatusInput => ({
  revision: 3,
  persons: [{ slug: 'hauptperson' }],
  documents: [{ documentId: D1, status: 'confirmado', available: true }],
  fields: [{ fieldId: 'f1', conceptId: 'bruttolohn_jahr', variant: '', tipo: 'amount', status: 'confirmado', evidence: [{ documentId: D1, page: 0 }] }],
});
const run = (i: StatusInput) => caseStatus(i, CONCEPTS);

describe('caseStatus', () => {
  it('sin bloqueos: revisable, sin avisos', () => {
    expect(run(base())).toEqual({ status: 'revisable', blockers: [], warnings: [] });
  });
  it('sin_campos: ningún campo confirmado', () => {
    const i = base();
    i.fields = [];
    expect(run(i)).toEqual({ status: 'incompleto', blockers: [{ code: 'sin_campos', entity: 'case' }], warnings: [] });
  });
  it('sin_campos: solo hay campos pendientes (además de campo_pendiente)', () => {
    const i = base();
    i.fields[0]!.status = 'pendiente';
    expect(run(i).blockers.map((b) => b.code).sort()).toEqual(['campo_pendiente', 'sin_campos']);
  });
  it('documento_pendiente', () => {
    const i = base();
    i.documents.push({ documentId: 'd2', status: 'pendiente_de_revision', available: true });
    expect(run(i).blockers).toEqual([{ code: 'documento_pendiente', entity: 'document', id: 'd2' }]);
  });
  it('un documento descartado o capturado no bloquea', () => {
    const i = base();
    i.documents.push({ documentId: 'd2', status: 'descartado', available: true });
    expect(run(i).blockers).toEqual([]);
  });
  it('campo_pendiente', () => {
    const i = base();
    i.fields.push({ fieldId: 'f2', conceptId: 'nettolohn_jahr', variant: '', tipo: 'amount', status: 'pendiente', evidence: [] });
    expect(run(i).blockers).toEqual([{ code: 'campo_pendiente', entity: 'field', id: 'f2' }]);
  });
  it('concepto_desconocido: concepto fuera del catálogo', () => {
    const i = base();
    i.fields[0]!.conceptId = 'inventado';
    expect(run(i).blockers).toEqual([{ code: 'concepto_desconocido', entity: 'field', id: 'f1' }]);
  });
  it('concepto_desconocido: variante que no corresponde', () => {
    const i = base();
    i.fields[0]!.variant = 'partner';
    expect(run(i).blockers).toEqual([{ code: 'concepto_desconocido', entity: 'field', id: 'f1' }]);
  });
  it('concepto_desconocido: tipo distinto del del catálogo', () => {
    const i = base();
    i.fields[0]!.tipo = 'text';
    expect(run(i).blockers).toEqual([{ code: 'concepto_desconocido', entity: 'field', id: 'f1' }]);
  });
  it('variante de persona existente o familie es válida', () => {
    const i = base();
    i.fields.push(
      { fieldId: 'f2', conceptId: 'krankenkasse_praemie', variant: 'hauptperson', tipo: 'amount', status: 'confirmado', evidence: [] },
      { fieldId: 'f3', conceptId: 'krankenkasse_praemie', variant: 'familie', tipo: 'amount', status: 'confirmado', evidence: [] },
    );
    expect(run(i).blockers).toEqual([]);
  });
  it('evidencia_no_confirmada: cita un documento pendiente', () => {
    const i = base();
    i.documents[0]!.status = 'pendiente_de_revision';
    expect(run(i).blockers.filter((b) => b.code === 'evidencia_no_confirmada')).toEqual([{ code: 'evidencia_no_confirmada', entity: 'field', id: 'f1' }]);
  });
  it('original_no_disponible: documento citado y no disponible', () => {
    const i = base();
    i.documents[0]!.available = false;
    expect(run(i).blockers).toEqual([{ code: 'original_no_disponible', entity: 'document', id: D1 }]);
  });
  it('un documento no disponible que nadie cita no bloquea', () => {
    const i = base();
    i.documents.push({ documentId: 'd2', status: 'confirmado', available: false });
    expect(run(i).blockers).toEqual([]);
  });
  it('campo confirmado sin evidencia: aviso, sin bloqueo', () => {
    const i = base();
    i.fields[0]!.evidence = [];
    expect(run(i)).toEqual({ status: 'revisable', blockers: [], warnings: [{ code: 'sin_evidencia', fieldId: 'f1' }] });
  });
  it('aprobación de la revisión actual: aprobado', () => {
    expect(run({ ...base(), lastApproval: { caseRevision: 3 } }).status).toBe('aprobado');
  });
  it('aprobación de una revisión anterior: revisable', () => {
    expect(run({ ...base(), lastApproval: { caseRevision: 2 } }).status).toBe('revisable');
  });
  it('aprobación anterior con bloqueos: incompleto', () => {
    const i = base();
    i.fields = [];
    expect(run({ ...i, lastApproval: { caseRevision: 2 } }).status).toBe('incompleto');
  });
});
