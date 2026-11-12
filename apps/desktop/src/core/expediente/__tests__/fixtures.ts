import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExpedienteService } from '../index.js';

/** Utilidades compartidas por las pruebas del expediente (servicio abierto, paquetes de inbox/). */
export const open: ExpedienteService[] = [];
let tick = 0;
export async function mk(dataDir = mkdtempSync(join(tmpdir(), 'fodibo-imp-')), hooks?: { beforeImportCommit?: () => void }) {
  const inboxDir = join(dataDir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const svc = await ExpedienteService.open({ dataDir, inboxDir, hooks, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  open.push(svc);
  const c = svc.createCase({ taxYear: 2025, jurisdiction: 'ZH', persons: [{ role: 'hauptperson', label: 'Ana' }] });
  return { svc, dataDir, inboxDir, dbDir: join(dataDir, 'expediente'), caseId: c.caseId };
}
export function closeAll(): void {
  while (open.length) open.pop()!.close();
}

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('datos-png')]);
export const JSON_ = Buffer.from('{"a":1}');

export type F = { name: string; mime: string; body: Buffer };
export const three: F[] = [
  { name: 'lohn/../Lohnausweis', mime: 'application/pdf', body: PDF },
  { name: 'foto.png', mime: 'image/png', body: PNG },
  { name: 'datos.json', mime: 'application/json', body: JSON_ },
];

export function writePackage(
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
