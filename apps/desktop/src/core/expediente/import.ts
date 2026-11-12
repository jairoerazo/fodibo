import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestSchema, receiptSchema } from '@fodibo/contracts';
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Ajv2020 as Ajv2020Type } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { originalName } from '../transfer/inbox.js';
import { MAX_FILE_BYTES, MAX_PACKAGE_BYTES, type Manifest, type Receipt } from '../transfer/types.js';
import { ExpedienteError } from './errors.js';
import type { ChangeEntry } from './service.js';
import type { BlobStore, CaseStore } from './storage/index.js';
import type { DocumentRow } from './types.js';

const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Type;
const ajv = new Ajv2020({ strict: true });
(addFormats as unknown as (a: Ajv2020Type) => void)(ajv);
const validateManifest = ajv.compile<Manifest>(manifestSchema);
const validateReceipt = ajv.compile<Receipt>(receiptSchema);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export type ImportablePackage = { packageId: string; deviceName: string; receivedAt: string; fileCount: number };
export type ImportedDocument = { documentId: string; sha256: string; name: string; outcome: 'nuevo' | 'existente' };
export type ImportResult = { status: 'imported' | 'already_imported'; documents: ImportedDocument[] };
export type RecoverResult = { removedTmp: number; removedOrphans: number; missing: string[] };

/** Lo que el servicio entrega a este módulo: las escrituras de contenido siguen pasando por su `transact`/`commitChange`. */
export type ImportContext = {
  store: CaseStore;
  blobs: BlobStore;
  inboxDir: string;
  now: () => Date;
  hooks: { beforeImportCommit?: () => void };
  /** Recibe el hash de cada blob que esta importación ha publicado de verdad (no los que ya estaban). */
  onBlobWritten?: (sha256: string) => void;
  transact: <T>(fn: () => T) => T;
  commitChange: (caseId: string, entries: ChangeEntry[]) => number;
};

const invalidPackage = (message: string): ExpedienteError => new ExpedienteError('package_invalid', message);
const integrity = (message: string): ExpedienteError => new ExpedienteError('integrity_error', message);

/** Lee un JSON de `inbox/` (archivo regular, tamaño acotado). `undefined` si no existe; `package_invalid` si es ilegible. */
async function readJson(path: string): Promise<{ data: unknown; raw: Buffer } | undefined> {
  let raw: Buffer;
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) throw invalidPackage('El paquete contiene un archivo de control no válido.');
    raw = await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    if (e instanceof ExpedienteError) throw e;
    throw invalidPackage('No se puede leer el paquete.');
  }
  try {
    return { data: JSON.parse(raw.toString('utf8')), raw };
  } catch {
    throw invalidPackage('El paquete contiene un archivo de control ilegible.');
  }
}

type Loaded = { manifest: Manifest; receipt: Receipt; manifestSha256: string };

async function loadPackage(inboxDir: string, packageId: string): Promise<Loaded> {
  const dir = join(inboxDir, packageId);
  const receiptFile = await readJson(join(dir, 'receipt.json'));
  if (!receiptFile) throw new ExpedienteError('package_incomplete', 'El paquete no está completo: falta el recibo.');
  const manifestFile = await readJson(join(dir, 'manifest.json'));
  if (!manifestFile) throw invalidPackage('Falta el manifiesto del paquete.');
  if (!validateManifest(manifestFile.data)) throw invalidPackage('El manifiesto del paquete no es válido.');
  if (!validateReceipt(receiptFile.data)) throw invalidPackage('El recibo del paquete no es válido.');
  const manifest = manifestFile.data;
  const receipt = receiptFile.data;
  if (manifest.package_id.toLowerCase() !== packageId.toLowerCase() || receipt.package_id.toLowerCase() !== packageId.toLowerCase()) {
    throw invalidPackage('El identificador del paquete no coincide con su directorio.');
  }
  checkConsistency(manifest, receipt);
  return { manifest, receipt, manifestSha256: createHash('sha256').update(manifestFile.raw).digest('hex') };
}

function checkConsistency(manifest: Manifest, receipt: Receipt): void {
  if (manifest.files.length !== receipt.files.length) throw invalidPackage('El recibo no coincide con el manifiesto.');
  const received = new Map(receipt.files.map((f) => [f.file_id, f]));
  const declared = new Set(manifest.files.map((f) => f.file_id));
  if (declared.size !== manifest.files.length) throw invalidPackage('El manifiesto repite identificadores de archivo.');
  if (received.size !== receipt.files.length) throw invalidPackage('El recibo repite identificadores de archivo.');
  for (const id of received.keys()) if (!declared.has(id)) throw invalidPackage('El recibo no coincide con el manifiesto.');
  const bySha = new Map<string, { size: number; mime: string }>();
  let total = 0;
  for (const f of manifest.files) {
    const r = received.get(f.file_id);
    if (!r || r.sha256 !== f.sha256 || r.size !== f.size || r.mime !== f.mime || r.name !== f.name) {
      throw invalidPackage('El recibo no coincide con el manifiesto.');
    }
    if (f.size > MAX_FILE_BYTES) throw invalidPackage('Un archivo del paquete supera el límite de tamaño.');
    total += f.size;
    const prev = bySha.get(f.sha256);
    if (prev && (prev.size !== f.size || prev.mime !== f.mime)) throw invalidPackage('El manifiesto declara datos contradictorios para un mismo archivo.');
    bySha.set(f.sha256, { size: f.size, mime: f.mime });
  }
  if (received.size !== manifest.files.length) throw invalidPackage('El recibo repite archivos.');
  if (total > MAX_PACKAGE_BYTES) throw invalidPackage('El paquete supera el límite de tamaño.');
}

export async function listImportable(ctx: ImportContext): Promise<ImportablePackage[]> {
  let names: string[];
  try {
    names = (await readdir(ctx.inboxDir)).filter((n) => UUID_RE.test(n));
  } catch {
    return [];
  }
  const out: ImportablePackage[] = [];
  for (const id of names) {
    if (ctx.store.getImport(id)) continue;
    try {
      const { manifest, receipt } = await loadPackage(ctx.inboxDir, id);
      out.push({ packageId: id, deviceName: manifest.device_name, receivedAt: receipt.received_at, fileCount: receipt.files.length });
    } catch {
      /* incompleto o ilegible: no es importable */
    }
  }
  return out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
}

function previousResult(ctx: ImportContext, packageId: string): ImportResult {
  return {
    status: 'already_imported',
    documents: ctx.store.listImportFiles(packageId).map((f) => ({ documentId: f.document_id, sha256: f.sha256, name: f.name, outcome: 'existente' as const })),
  };
}

/** Si el paquete ya está registrado: su resultado anterior en este expediente, o `package_in_other_case`. */
function existing(ctx: ImportContext, caseId: string, packageId: string): ImportResult | undefined {
  const row = ctx.store.getImport(packageId);
  if (!row) return undefined;
  if (row.case_id !== caseId) {
    throw new ExpedienteError('package_in_other_case', 'El paquete ya se importó en otro expediente.', { caseId: row.case_id });
  }
  return previousResult(ctx, packageId);
}

export async function importPackage(ctx: ImportContext, caseId: string, packageId: string): Promise<ImportResult> {
  if (typeof packageId !== 'string' || !UUID_RE.test(packageId)) throw new ExpedienteError('invalid_input', 'Identificador de paquete no válido.', { field: 'packageId' });
  packageId = packageId.toLowerCase();
  if (!ctx.store.getCase(caseId)) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
  const done = existing(ctx, caseId, packageId);
  if (done) return done;

  const { manifest, manifestSha256 } = await loadPackage(ctx.inboxDir, packageId);

  // Archivos antes que metadatos (§4.2). Si algo falla aquí, se retiran los blobs que esta llamada acaba de crear.
  const added: string[] = [];
  const written: string[] = [];
  try {
    const seen = new Set<string>();
    for (const f of manifest.files) {
      if (seen.has(f.sha256)) continue;
      seen.add(f.sha256);
      if (await ctx.blobs.has(f.sha256)) continue;
      const source = join(ctx.inboxDir, packageId, 'files', f.sha256);
      let regular: boolean;
      try {
        regular = (await lstat(source)).isFile();
      } catch {
        throw integrity('Falta un archivo del paquete.');
      }
      if (!regular) throw integrity('Un archivo del paquete no es un archivo regular.');
      try {
        await ctx.blobs.put(source, { sha256: f.sha256, size: f.size, mime: f.mime });
      } catch (e) {
        if (e instanceof ExpedienteError) throw e;
        throw integrity('No se pudo copiar un archivo del paquete.');
      }
      added.push(f.sha256);
      written.push(f.sha256);
    }
  } catch (e) {
    await Promise.all(added.map((sha) => ctx.blobs.remove(sha).catch(() => undefined)));
    throw e;
  }

  const result: ImportResult = { status: 'imported', documents: [] };
  ctx.transact(() => {
    const importedAt = ctx.now().toISOString();
    ctx.store.insertImport({ package_id: packageId, case_id: caseId, imported_at: importedAt, device_name: manifest.device_name, manifest_sha256: manifestSha256 });
    const entries: ChangeEntry[] = [
      { entity: 'import', entityId: packageId, action: 'create', before: null, after: { device_name: manifest.device_name, file_count: manifest.files.length } },
    ];
    const created = new Set<string>();
    const docIds = new Map<string, string>();
    for (const f of manifest.files) {
      const name = originalName(f.name, f.mime);
      let documentId = docIds.get(f.sha256);
      let outcome: 'nuevo' | 'existente' = 'existente';
      if (documentId === undefined) {
        const prior = ctx.store.getDocumentBySha(caseId, f.sha256);
        if (prior) {
          documentId = prior.document_id;
        } else {
          documentId = randomUUID();
          const row: DocumentRow = {
            document_id: documentId,
            case_id: caseId,
            sha256: f.sha256,
            mime: f.mime,
            size: f.size,
            original_name: name,
            doc_type: null,
            status: 'pendiente_de_revision',
            source_device: manifest.device_name,
            imported_at: importedAt,
          };
          ctx.store.insertDocument(row);
          created.add(documentId);
          outcome = 'nuevo';
          entries.push({
            entity: 'document',
            entityId: documentId,
            action: 'create',
            before: null,
            after: { sha256: row.sha256, mime: row.mime, size: row.size, original_name: row.original_name, status: row.status, source_device: row.source_device },
          });
        }
        docIds.set(f.sha256, documentId);
      }
      ctx.store.insertImportFile({ package_id: packageId, file_id: f.file_id, document_id: documentId, name });
      result.documents.push({ documentId, sha256: f.sha256, name, outcome });
    }
    ctx.hooks.beforeImportCommit?.();
    // Sin documentos nuevos no hay cambio de contenido: imports/import_files son solo registro de idempotencia (sin revisión).
    if (created.size > 0) ctx.commitChange(caseId, entries);
  });
  for (const sha of written) ctx.onBlobWritten?.(sha);
  return result;
}

export async function recoverStore(ctx: Pick<ImportContext, 'store' | 'blobs'>): Promise<RecoverResult> {
  const removedTmp = await ctx.blobs.cleanTmp();
  const docs = ctx.store.listDocumentBlobs();
  const referenced = new Set(docs.map((d) => d.sha256));
  let removedOrphans = 0;
  for (const sha of await ctx.blobs.list()) {
    if (referenced.has(sha)) continue;
    await ctx.blobs.remove(sha);
    removedOrphans++;
  }
  const missing: string[] = [];
  for (const d of docs) {
    const st = await ctx.blobs.stat(d.sha256);
    if (!st || st.size !== d.size) missing.push(d.document_id);
  }
  return { removedTmp, removedOrphans, missing };
}
