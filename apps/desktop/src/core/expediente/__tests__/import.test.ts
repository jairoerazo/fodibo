import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpedienteError, ExpedienteService } from '../index.js';
import { openRaw } from '../storage/__tests__/helpers.js';

const open: ExpedienteService[] = [];
let tick = 0;
async function mk(dataDir = mkdtempSync(join(tmpdir(), 'fodibo-imp-')), hooks?: { beforeImportCommit?: () => void }) {
  const inboxDir = join(dataDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const svc = await ExpedienteService.open({ dataDir, inboxDir, hooks, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  open.push(svc);
  const c = svc.createCase({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Ana' }] });
  return { svc, dataDir, inboxDir, dbDir: join(dataDir, 'expediente'), caseId: c.caseId };
}
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('datos-png')]);
const JSON_ = Buffer.from('{"a":1}');

type F = { name: string; mime: string; body: Buffer };
const three: F[] = [
  { name: 'lohn/../Lohnausweis', mime: 'application/pdf', body: PDF },
  { name: 'foto.png', mime: 'image/png', body: PNG },
  { name: 'datos.json', mime: 'application/json', body: JSON_ },
];

function writePackage(
  inboxDir: string,
  files: F[],
  o: { packageId?: string; receipt?: boolean; device?: string; receivedAt?: string; manifestId?: string } = {},
) {
  const packageId = o.packageId ?? randomUUID();
  const dir = join(inboxDir, packageId);
  mkdirSync(join(dir, 'files'), { recursive: true });
  const entries = files.map((f) => ({ file_id: randomUUID(), name: f.name, mime: f.mime, size: f.body.length, sha256: sha(f.body) }));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ schema_version: 1, package_id: o.manifestId ?? packageId, created_at: '2026-01-01T00:00:00.000Z', device_name: o.device ?? 'iPhone de Ana', files: entries }),
  );
  files.forEach((f, i) => writeFileSync(join(dir, 'files', entries[i]!.sha256), f.body));
  if (o.receipt !== false) {
    writeFileSync(
      join(dir, 'receipt.json'),
      JSON.stringify({ schema_version: 1, package_id: packageId, received_at: o.receivedAt ?? '2026-01-02T00:00:00.000Z', files: entries.map((e) => ({ ...e, status: 'stored' })) }),
    );
  }
  return { packageId, dir, entries };
}

function snapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = statSync(p).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function count(dbDir: string, sql: string, ...args: string[]): number {
  const raw = openRaw(dbDir);
  try {
    return (raw.prepare(sql).get(...args) as { n: number }).n;
  } finally {
    raw.close();
  }
}
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ExpedienteError;
  }
  throw new Error('no lanzó');
};

describe('importPackage', () => {
  it('importa un paquete completo sin tocar inbox/', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three);
    const before = snapshot(inboxDir);
    const events: number[] = [];
    svc.on((e) => events.push(e.revision));

    const res = await svc.importPackage(caseId, pkg.packageId);
    expect(res.status).toBe('imported');
    expect(res.documents.map((d) => d.outcome)).toEqual(['nuevo', 'nuevo', 'nuevo']);
    expect(res.documents[0]!.name).toBe('Lohnausweis.pdf');
    expect(svc.getCase(caseId).revision).toBe(1);
    expect(events).toEqual([1]);

    const raw = openRaw(dbDir);
    const docs = raw.prepare('SELECT * FROM documents ORDER BY original_name').all() as Array<Record<string, unknown>>;
    const changes = raw.prepare('SELECT entity, entity_id, action, revision FROM changes WHERE revision = 1').all();
    raw.close();
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.status === 'pendiente_de_revision' && d.source_device === 'iPhone de Ana')).toBe(true);
    expect(docs.map((d) => d.original_name)).toEqual(['Lohnausweis.pdf', 'datos.json', 'foto.png']);
    expect(changes.map((c) => (c as { entity: string }).entity).sort()).toEqual(['document', 'document', 'document', 'import']);
    expect(changes.find((c) => (c as { entity: string }).entity === 'import')).toMatchObject({ entity_id: pkg.packageId, action: 'create' });
    for (const e of pkg.entries) expect(await (svc as unknown as { blobs: { has(s: string): Promise<boolean> } }).blobs.has(e.sha256)).toBe(true);
    expect(snapshot(inboxDir)).toEqual(before);
  });

  it('listImportable muestra los paquetes con recibo sin importar, del más reciente al más antiguo', async () => {
    const { svc, inboxDir, caseId } = await mk();
    const old = writePackage(inboxDir, [three[0]!], { receivedAt: '2026-01-01T00:00:00.000Z', device: 'A' });
    const recent = writePackage(inboxDir, [three[1]!], { receivedAt: '2026-03-01T00:00:00.000Z', device: 'B' });
    writePackage(inboxDir, [three[2]!], { receipt: false });
    expect(await svc.listImportable()).toEqual([
      { packageId: recent.packageId, deviceName: 'B', receivedAt: '2026-03-01T00:00:00.000Z', fileCount: 1 },
      { packageId: old.packageId, deviceName: 'A', receivedAt: '2026-01-01T00:00:00.000Z', fileCount: 1 },
    ]);
    await svc.importPackage(caseId, old.packageId);
    expect((await svc.listImportable()).map((p) => p.packageId)).toEqual([recent.packageId]);
  });

  it('sin recibo: package_incomplete y la base no cambia', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three, { receipt: false });
    expect((await rejects(svc.importPackage(caseId, pkg.packageId))).code).toBe('package_incomplete');
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM imports')).toBe(0);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(0);
    expect(svc.getCase(caseId).revision).toBe(0);
    expect(await svc.listImportable()).toEqual([]);
  });

  it('manifiesto inválido o package_id distinto del directorio: package_invalid', async () => {
    const { svc, inboxDir, caseId } = await mk();
    const other = writePackage(inboxDir, three, { manifestId: randomUUID() });
    expect((await rejects(svc.importPackage(caseId, other.packageId))).code).toBe('package_invalid');
    const bad = writePackage(inboxDir, three);
    writeFileSync(join(bad.dir, 'manifest.json'), '{"schema_version":1}');
    expect((await rejects(svc.importPackage(caseId, bad.packageId))).code).toBe('package_invalid');
  });

  it('reimportar devuelve already_imported sin cambiar revisión ni documentos', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three);
    const first = await svc.importPackage(caseId, pkg.packageId);
    const again = await svc.importPackage(caseId, pkg.packageId);
    expect(again.status).toBe('already_imported');
    expect(again.documents.map((d) => d.documentId)).toEqual(first.documents.map((d) => d.documentId));
    expect(again.documents.map((d) => d.name)).toEqual(first.documents.map((d) => d.name));
    expect(svc.getCase(caseId).revision).toBe(1);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(3);
  });

  it('el mismo hash en dos paquetes: un documento, un blob; sin aportar nada nuevo la revisión no cambia', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const a = writePackage(inboxDir, [three[0]!]);
    const b = writePackage(inboxDir, [{ ...three[0]!, name: 'otra-copia.pdf' }]);
    const first = await svc.importPackage(caseId, a.packageId);
    const second = await svc.importPackage(caseId, b.packageId);
    expect(second.status).toBe('imported');
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]).toMatchObject({ outcome: 'existente', documentId: first.documents[0]!.documentId });
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(1);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM imports')).toBe(2);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM import_files')).toBe(2);
    expect(svc.getCase(caseId).revision).toBe(1);
    expect((await (svc as unknown as { blobs: { list(): Promise<string[]> } }).blobs.list()).length).toBe(1);
  });

  it('hash repetido dentro del paquete: un documento y dos import_files', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, [three[0]!, { ...three[0]!, name: 'copia.pdf' }]);
    const res = await svc.importPackage(caseId, pkg.packageId);
    expect(res.documents.map((d) => d.outcome)).toEqual(['nuevo', 'existente']);
    expect(res.documents.map((d) => d.name)).toEqual(['Lohnausweis.pdf', 'copia.pdf']);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(1);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM import_files')).toBe(2);
    expect((await svc.importPackage(caseId, pkg.packageId)).documents.map((d) => d.name)).toEqual(['Lohnausweis.pdf', 'copia.pdf']);
  });

  it('archivo alterado en inbox/: integrity_error, sin filas ni blob', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three);
    writeFileSync(join(pkg.dir, 'files', pkg.entries[1]!.sha256), Buffer.concat([PNG.subarray(0, 8), Buffer.from('alterado!')]));
    expect((await rejects(svc.importPackage(caseId, pkg.packageId))).code).toBe('integrity_error');
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM imports')).toBe(0);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(0);
    expect(await (svc as unknown as { blobs: { list(): Promise<string[]> } }).blobs.list()).toEqual([]);
    expect(svc.getCase(caseId).revision).toBe(0);
  });

  it('enlace simbólico en files/: integrity_error', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, [three[0]!]);
    const target = join(pkg.dir, 'real.pdf');
    writeFileSync(target, PDF);
    const link = join(pkg.dir, 'files', pkg.entries[0]!.sha256);
    rmSync(link);
    symlinkSync(target, link);
    expect((await rejects(svc.importPackage(caseId, pkg.packageId))).code).toBe('integrity_error');
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(0);
  });

  it('paquete ya importado en otro expediente: package_in_other_case con su caseId', async () => {
    const { svc, inboxDir, caseId } = await mk();
    const other = svc.createCase({ taxYear: 2024, jurisdiction: 'BE', persons: [{ role: 'hauptperson', label: 'Zoe' }] });
    const pkg = writePackage(inboxDir, three);
    await svc.importPackage(caseId, pkg.packageId);
    const err = await rejects(svc.importPackage(other.caseId, pkg.packageId));
    expect(err.code).toBe('package_in_other_case');
    expect(err.details).toEqual({ caseId });
  });

  it('fallo antes del COMMIT: sin filas, blobs huérfanos que recover() borra, y se puede reimportar', async () => {
    let fail = true;
    const dataDir = mkdtempSync(join(tmpdir(), 'fodibo-imp-'));
    const { svc, inboxDir, dbDir, caseId } = await mk(dataDir, {
      beforeImportCommit: () => {
        if (fail) throw new Error('boom');
      },
    });
    const pkg = writePackage(inboxDir, three);
    await expect(svc.importPackage(caseId, pkg.packageId)).rejects.toThrow('boom');
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM imports')).toBe(0);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(0);
    expect(svc.getCase(caseId).revision).toBe(0);
    const blobs = (s: ExpedienteService) => (s as unknown as { blobs: { list(): Promise<string[]> } }).blobs.list();
    expect(await blobs(svc)).toHaveLength(3);
    svc.close();
    open.pop();

    const again = await ExpedienteService.open({ dataDir, inboxDir });
    open.push(again);
    expect(await blobs(again)).toEqual([]);
    expect(await again.recover()).toEqual({ removedTmp: 0, removedOrphans: 0, missing: [] });
    fail = false;
    expect((await again.importPackage(caseId, pkg.packageId)).status).toBe('imported');
  });

  it('dos importPackage simultáneos del mismo paquete: uno imported y otro already_imported', async () => {
    const { svc, inboxDir, dbDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three);
    const res = await Promise.all([svc.importPackage(caseId, pkg.packageId), svc.importPackage(caseId, pkg.packageId)]);
    expect(res.map((r) => r.status).sort()).toEqual(['already_imported', 'imported']);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM imports')).toBe(1);
    expect(count(dbDir, 'SELECT COUNT(*) AS n FROM documents')).toBe(3);
    expect(svc.getCase(caseId).revision).toBe(1);
  });
});

describe('recover', () => {
  it('detecta un blob borrado y limpia temporales', async () => {
    const { svc, inboxDir, dataDir, caseId } = await mk();
    const pkg = writePackage(inboxDir, three);
    const res = await svc.importPackage(caseId, pkg.packageId);
    const gone = res.documents[1]!;
    const blobDir = join(dataDir, 'expediente', 'blobs');
    rmSync(join(blobDir, gone.sha256.slice(0, 2), gone.sha256));
    mkdirSync(join(blobDir, 'tmp'), { recursive: true });
    writeFileSync(join(blobDir, 'tmp', 'x.part'), 'resto');
    expect(await svc.recover()).toEqual({ removedTmp: 1, removedOrphans: 0, missing: [gone.documentId] });
  });
});
