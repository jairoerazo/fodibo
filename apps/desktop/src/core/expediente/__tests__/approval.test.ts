import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { approvedDeclarationSchema } from '@fodibo/contracts';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';
import { CONCEPTS, loadDeclaration } from '../../agent/index.js';
import { canonical } from '../../common/canonical.js';
import { ExpedienteError, type ExpedienteService } from '../index.js';
import { contentHash } from '../projection.js';
import { splitKey } from '../fields.js';
import { openRaw, readApproval, tamperApproval } from '../storage/__tests__/helpers.js';
import { approvable, closeAll, mk, three, writePackage } from './fixtures.js';

afterEach(closeAll);

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);
const validateSnapshot = ajv.compile(approvedDeclarationSchema);

const catchErr = (fn: () => unknown): ExpedienteError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExpedienteError) return e;
    throw e;
  }
  throw new Error('no lanzó');
};
const rev = (svc: ExpedienteService, caseId: string) => svc.getCase(caseId).revision;

describe('approve', () => {
  it('stale_revision si la revisión esperada no es la actual', async () => {
    const h = await approvable();
    const e = catchErr(() => h.svc.approve(h.caseId, rev(h.svc, h.caseId) - 1));
    expect(e.code).toBe('stale_revision');
    expect(readApproval(h.dbDir, h.caseId)).toBeUndefined();
  });

  it('blocked devuelve la lista de bloqueos', async () => {
    const h = await mk();
    const e = catchErr(() => h.svc.approve(h.caseId, 0));
    expect(e.code).toBe('blocked');
    expect(e.details).toEqual({ blockers: [{ code: 'sin_campos', entity: 'case' }] });
  });

  it('expediente desconocido: not_found', async () => {
    const h = await mk();
    expect(catchErr(() => h.svc.approve('00000000-0000-4000-8000-000000000000', 0)).code).toBe('not_found');
  });

  it('un concepto que salió del catálogo bloquea la aprobación (invariante 5)', async () => {
    const h = await approvable();
    const dataDir = h.dataDir;
    const { ExpedienteService: S } = await import('../index.js');
    const reduced = await S.open({ dataDir, inboxDir: h.inboxDir, concepts: CONCEPTS.filter((c) => c.id !== 'bruttolohn_jahr') });
    try {
      const e = catchErr(() => reduced.approve(h.caseId, reduced.getCase(h.caseId).revision));
      expect(e.code).toBe('blocked');
      expect((e.details as { blockers: unknown[] }).blockers).toEqual([expect.objectContaining({ code: 'concepto_desconocido', entity: 'field' })]);
    } finally {
      reduced.close();
    }
  });

  it('la instantánea cumple el contrato y content.fields pasa loadDeclaration', async () => {
    const h = await approvable();
    const before = rev(h.svc, h.caseId);
    const summary = h.svc.approve(h.caseId, before);
    expect(summary).toEqual({ approvalId: expect.any(String), caseRevision: before, approvedAt: expect.any(String), contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(rev(h.svc, h.caseId)).toBe(before); // aprobar no cambia la revisión

    const row = readApproval(h.dbDir, h.caseId)!;
    const snap = JSON.parse(row.snapshot);
    expect(validateSnapshot(snap), JSON.stringify(validateSnapshot.errors)).toBe(true);
    expect(row.snapshot).toBe(canonical(snap));
    expect(snap).toMatchObject({ schema_version: 1, approver: 'usuario:local', case_id: h.caseId, case_revision: before, approval_id: summary.approvalId });
    expect(snap.content_hash).toBe(row.content_hash);
    expect(row.content_hash).toBe(summary.contentHash);
    expect(contentHash(snap.content)).toBe(row.content_hash);
    expect(loadDeclaration(snap.content.fields)).toEqual({ bruttolohn_jahr: { tipo: 'amount', valor: '85400.00', moneda: 'CHF' } });
    expect(snap.content.evidence).toEqual({ bruttolohn_jahr: [{ document_id: h.pdf, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), page: 1 }] });
    // documentos confirmados, ordenados por sha256
    const shas = snap.content.documents.map((d: { sha256: string }) => d.sha256);
    expect(shas).toEqual([...shas].sort());
    expect(snap.content.documents).toHaveLength(2);
    expect(snap.content.documents.map((d: { doc_type: string }) => d.doc_type).sort()).toEqual(['lohnausweis', 'quittung']);

    // queda registrada en changes con la revisión vigente
    const db = openRaw(h.dbDir);
    const ch = db.prepare("SELECT revision, entity_id, action FROM changes WHERE entity = 'approval'").all();
    db.close();
    expect(ch).toEqual([{ revision: before, entity_id: summary.approvalId, action: 'create' }]);
  });

  it('aprobar dos veces la misma revisión devuelve la aprobación existente', async () => {
    const h = await approvable();
    const r = rev(h.svc, h.caseId);
    const a = h.svc.approve(h.caseId, r);
    const b = h.svc.approve(h.caseId, r);
    expect(b).toEqual(a);
    const db = openRaw(h.dbDir);
    expect((db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('la huella no depende del orden de inserción', async () => {
    const h = await mk();
    const second = h.svc.createCase({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Ana' }] }).caseId;
    const fields = [
      { conceptId: 'nachname', variant: '', valor: 'Muster' },
      { conceptId: 'bruttolohn_jahr', variant: '', valor: '1000' },
      { conceptId: 'krankenkasse_praemie', variant: 'hauptperson', valor: '300' },
      { conceptId: 'krankenkasse_praemie', variant: 'familie', valor: '900' },
    ];
    for (const f of fields) h.svc.saveField(h.caseId, { ...f, evidence: [] });
    for (const f of [...fields].reverse()) h.svc.saveField(second, { ...f, evidence: [] });
    const a = h.svc.approve(h.caseId, rev(h.svc, h.caseId));
    const b = h.svc.approve(second, rev(h.svc, second));
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.approvalId).not.toBe(b.approvalId);
  });

  it('un documento citado que se queda sin original bloquea con original_no_disponible', async () => {
    const h = await approvable();
    const sha = h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.pdf)!.sha256;
    rmSync(join(h.dbDir, 'blobs', sha.slice(0, 2), sha));
    await h.svc.recover();
    const e = catchErr(() => h.svc.approve(h.caseId, rev(h.svc, h.caseId)));
    expect(e.details).toEqual({ blockers: [{ code: 'original_no_disponible', entity: 'document', id: h.pdf }] });
  });
});

describe('approvedDeclaration', () => {
  it('devuelve la declaración, el id, la revisión, la fecha y la huella', async () => {
    const h = await approvable();
    const s = h.svc.approve(h.caseId, rev(h.svc, h.caseId));
    expect(h.svc.approvedDeclaration(h.caseId)).toEqual({
      declaration: { bruttolohn_jahr: { tipo: 'amount', valor: '85400.00', moneda: 'CHF' } },
      ...s,
    });
  });

  it('no_approval si nunca se aprobó; not_found si no existe', async () => {
    const h = await approvable();
    expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('no_approval');
    expect(catchErr(() => h.svc.approvedDeclaration('00000000-0000-4000-8000-000000000000')).code).toBe('not_found');
  });

  it('approval_stale tras un cambio', async () => {
    const h = await approvable();
    h.svc.approve(h.caseId, rev(h.svc, h.caseId));
    h.svc.updateCase(h.caseId, { taxYear: 2024 });
    expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_stale');
  });

  describe('approval_corrupt (manipulación simulada por SQL directo)', () => {
    const approved = async () => {
      const h = await approvable();
      h.svc.approve(h.caseId, rev(h.svc, h.caseId));
      return h;
    };

    it('el disparador impide alterar la aprobación sin manipular el esquema', async () => {
      const h = await approved();
      const db = openRaw(h.dbDir);
      expect(() => db.exec("UPDATE approvals SET snapshot = 'x'")).toThrow(/inmutable/);
      expect(() => db.exec('DELETE FROM approvals')).toThrow(/inmutable/);
      db.close();
      expect(h.svc.approvedDeclaration(h.caseId).declaration).toBeDefined();
    });

    it('un byte alterado en el valor de un campo', async () => {
      const h = await approved();
      tamperApproval(h.dbDir, h.caseId, 'snapshot', (s) => s.replace('85400.00', '85400.01'));
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_corrupt');
    });

    it('la huella de la columna alterada', async () => {
      const h = await approved();
      tamperApproval(h.dbDir, h.caseId, 'content_hash', (s) => `${s[0] === 'a' ? 'b' : 'a'}${s.slice(1)}`);
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_corrupt');
    });

    it('la huella dentro de la instantánea alterada', async () => {
      const h = await approved();
      tamperApproval(h.dbDir, h.caseId, 'snapshot', (s) => {
        const o = JSON.parse(s);
        o.content_hash = '0'.repeat(64);
        return canonical(o);
      });
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_corrupt');
    });

    it('JSON ilegible', async () => {
      const h = await approved();
      tamperApproval(h.dbDir, h.caseId, 'snapshot', () => '{no es json');
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_corrupt');
    });

    it('contenido inválido con huella recalculada coherente: loadDeclaration lo rechaza', async () => {
      const h = await approved();
      const hash = (o: { content: unknown }) => contentHash(o.content);
      tamperApproval(h.dbDir, h.caseId, 'snapshot', (s) => {
        const o = JSON.parse(s);
        o.content.fields.iban = { tipo: 'iban', valor: 'CH0000000000000000000' };
        o.content.evidence.iban = [];
        o.content_hash = hash(o);
        return canonical(o);
      });
      const fixed = readApproval(h.dbDir, h.caseId)!;
      tamperApproval(h.dbDir, h.caseId, 'content_hash', () => JSON.parse(fixed.snapshot).content_hash);
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_corrupt');
    });

    it('una aprobación obsoleta se informa como approval_stale antes que como corrupta', async () => {
      const h = await approved();
      tamperApproval(h.dbDir, h.caseId, 'snapshot', (s) => s.replace('85400.00', '85400.01'));
      h.svc.updateCase(h.caseId, { taxYear: 2024 });
      expect(catchErr(() => h.svc.approvedDeclaration(h.caseId)).code).toBe('approval_stale');
    });
  });
});

describe('disponibilidad de originales', () => {
  it('un documento sin blob tras recover() figura como no disponible, y un import que restaura el blob lo rehabilita', async () => {
    const h = await approvable();
    const doc = h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.pdf)!;
    expect(doc.available).toBe(true);
    rmSync(join(h.dbDir, 'blobs', doc.sha256.slice(0, 2), doc.sha256));
    await h.svc.recover();
    expect(h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.pdf)!.available).toBe(false);
    expect(h.svc.getCase(h.caseId).blockers).toContainEqual({ code: 'original_no_disponible', entity: 'document', id: h.pdf });
    // otro paquete con el mismo archivo repone el blob
    const res = await h.svc.importPackage(h.caseId, writePackage(h.inboxDir, three.slice(0, 1)).packageId);
    expect(res.documents[0]).toMatchObject({ documentId: h.pdf, outcome: 'existente' });
    expect(h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.pdf)!.available).toBe(true);
    expect(h.svc.getCase(h.caseId).blockers).toEqual([]);
  });

  it('reportUnavailable marca un documento tras una lectura fallida', async () => {
    const h = await approvable();
    h.svc.reportUnavailable(h.png);
    expect(h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.png)!.available).toBe(false);
    expect(h.svc.getCase(h.caseId).documents.find((d) => d.documentId === h.pdf)!.available).toBe(true);
  });
});

/** Generador pseudoaleatorio determinista. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('propiedad de proyección (criterio 11)', () => {
  const IBANS = ['CH9300762011623852957', 'DE89370400440532013000', 'GB82WEST12345698765432'];
  it('50 expedientes aleatorios con semilla fija: la proyección pasa loadDeclaration y sus claves son únicas y del catálogo', async () => {
    const rnd = mulberry32(20261112);
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
    const h = await mk();
    for (let n = 0; n < 50; n++) {
      const persons: Array<{ role: 'hauptperson' | 'partner' | 'kind'; label: string }> = [{ role: 'hauptperson', label: 'Ana' }];
      if (rnd() < 0.5) persons.push({ role: 'partner', label: 'Beat' });
      for (let k = int(3); k > 0; k--) persons.push({ role: 'kind', label: `Kind${k}` });
      const c = h.svc.createCase({ taxYear: 2000 + int(100), jurisdiction: pick(['ZH', 'BE', 'GE', 'TI']), persons });
      const slugs = [...c.persons.map((p) => p.slug), 'familie'];
      const wanted = CONCEPTS.filter(() => rnd() < 0.5);
      if (wanted.length === 0) wanted.push(CONCEPTS[0]!);
      let count = 0;
      for (const concept of wanted) {
        const variants = concept.variants ? slugs.filter(() => rnd() < 0.6) : [''];
        for (const variant of concept.variants && variants.length === 0 ? [slugs[0]!] : variants) {
          const valor =
            concept.tipo === 'amount'
              ? `${int(1_000_000)}.${String(int(100)).padStart(2, '0')}`
              : concept.tipo === 'date'
                ? `${1950 + int(70)}-${String(1 + int(12)).padStart(2, '0')}-${String(1 + int(28)).padStart(2, '0')}`
                : concept.tipo === 'iban'
                  ? pick(IBANS)
                  : concept.tipo === 'enum'
                    ? pick(concept.values!)
                    : `Texto${int(1000)}`;
          h.svc.saveField(c.caseId, { conceptId: concept.id, variant, valor, evidence: [] });
          count++;
        }
      }
      const s = h.svc.approve(c.caseId, h.svc.getCase(c.caseId).revision);
      const { declaration, contentHash: hash } = h.svc.approvedDeclaration(c.caseId);
      expect(hash).toBe(s.contentHash);
      expect(loadDeclaration(JSON.parse(JSON.stringify(declaration)))).toEqual(declaration);
      const keys = Object.keys(declaration);
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(splitKey(k, CONCEPTS), k).toBeDefined();
    }
  });
});
