import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExpedienteError } from '../errors.js';
import type { CaseRow, ChangeRow, DocumentRow, ImportFileRow, ImportRow, PersonRow } from '../types.js';
import { MIGRATIONS, type Migration } from './schema.js';

export type OpenStoreOptions = {
  dir: string;
  /** Reservado para el cifrado en reposo; todavía no se usa. */
  key?: Uint8Array;
  now?: () => Date;
  /** Sustituye el conjunto de migraciones (pruebas). */
  migrations?: Migration[];
};

export interface CaseStore {
  /** Ejecuta `fn` en una transacción síncrona (BEGIN IMMEDIATE); revierte si lanza. No anida: una llamada dentro de `fn` falla con storage_error. */
  transaction<T>(fn: () => T): T;
  insertCase(row: CaseRow): void;
  getCase(caseId: string): CaseRow | undefined;
  /** Expedientes con el rótulo de su titular, del más antiguo al más reciente. */
  listCaseSummaries(): Array<CaseRow & { hauptperson_label: string | null }>;
  updateCaseHeader(caseId: string, taxYear: number, jurisdiction: string): void;
  /** Suma 1 a la revisión del expediente y devuelve la nueva. Solo dentro de una transacción. */
  incrementRevision(caseId: string): number;
  insertChange(row: Omit<ChangeRow, 'change_id'>): void;
  listChanges(caseId: string): ChangeRow[];
  insertPerson(row: PersonRow): void;
  deletePerson(personId: string): void;
  updatePersonLabel(personId: string, label: string): void;
  /** Titular, pareja e hijos por ordinal. */
  listPersons(caseId: string): PersonRow[];
  /** Mayor ordinal de `kind` usado jamás en el expediente (también por personas dadas de baja; sale de `changes`). 0 si no hubo ninguno. */
  maxKindOrdinal(caseId: string): number;
  /** Campos del expediente cuya variante es el `slug` dado. */
  fieldIdsWithVariant(caseId: string, slug: string): string[];
  getImport(packageId: string): ImportRow | undefined;
  insertImport(row: ImportRow): void;
  insertImportFile(row: ImportFileRow): void;
  /** Archivos de un paquete importado en el orden en que se registraron, con el hash de su documento. */
  listImportFiles(packageId: string): Array<ImportFileRow & { sha256: string }>;
  insertDocument(row: DocumentRow): void;
  getDocumentBySha(caseId: string, sha256: string): DocumentRow | undefined;
  /** Hash y tamaño de todos los documentos de todos los expedientes (recuperación al arrancar). */
  listDocumentBlobs(): Array<{ document_id: string; sha256: string; size: number }>;
  close(): void;
}

export const DB_FILE = 'fodibo.db';

const storageError = (message: string): ExpedienteError => new ExpedienteError('storage_error', message);

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** Copia consistente de la base (con el WAL incluido) antes de migrar. */
function backup(db: DatabaseSync, dir: string, version: number, now: Date): void {
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  db.prepare('VACUUM INTO ?').run(join(backups, `fodibo-v${version}-${stamp}.db`));
}

function migrate(db: DatabaseSync, dir: string, migrations: Migration[], now: () => Date): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    const current = userVersion(db);
    if (m.version <= current) continue;
    try {
      // Una base nueva (versión 0) no tiene nada que proteger.
      if (current > 0) backup(db, dir, current, now());
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
      } catch (e) {
        rollback(db);
        throw e;
      }
    } catch {
      throw storageError(`La migración a la versión ${m.version} del esquema ha fallado; la base sigue en la versión ${current}.`);
    }
  }
}

/** SQLite puede haber revertido ya por su cuenta (disco lleno, E/S): entonces no hay nada que revertir. */
function rollback(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    /* se conserva el error original */
  }
}

export function openStore(opts: OpenStoreOptions): CaseStore {
  const now = opts.now ?? (() => new Date());
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  const file = join(opts.dir, DB_FILE);
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch {
    throw storageError('No se puede abrir la base del expediente.');
  }

  // Comprobaciones previas en una conexión de solo lectura: cerrar una conexión de escritura sobre una base WAL
  // con -wal caliente la checkpointea y borra -wal/-shm, es decir, modifica una base que no debemos tocar.
  if (existsSync(file)) {
    let probe: DatabaseSync | undefined;
    let version: number;
    let integrity: string;
    try {
      probe = new DatabaseSync(file, { readOnly: true });
      version = userVersion(probe);
      integrity = (probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    } catch {
      throw storageError('La base del expediente es ilegible.');
    } finally {
      probe?.close();
    }
    if (version > latest) {
      throw storageError(`La base del expediente es de una versión posterior (${version}) a la que conoce esta aplicación (${latest}).`);
    }
    if (integrity !== 'ok') throw storageError('La comprobación de integridad de la base del expediente ha fallado.');
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
  } catch {
    throw storageError('No se puede abrir la base del expediente.');
  }
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, opts.dir, migrations, now);
  } catch (e) {
    db.close();
    throw e;
  }

  const conn = db;
  const insertCase = conn.prepare(
    'INSERT INTO cases (case_id, tax_year, jurisdiction, rules_version, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const getCase = conn.prepare('SELECT * FROM cases WHERE case_id = ?');

  const listCaseSummaries = conn.prepare(
    `SELECT c.*, (SELECT p.label FROM persons p WHERE p.case_id = c.case_id AND p.role = 'hauptperson') AS hauptperson_label
     FROM cases c ORDER BY c.created_at, c.case_id`,
  );
  const updateCaseHeader = conn.prepare('UPDATE cases SET tax_year = ?, jurisdiction = ? WHERE case_id = ?');
  const incrementRevision = conn.prepare('UPDATE cases SET revision = revision + 1 WHERE case_id = ? RETURNING revision');
  const insertChange = conn.prepare(
    'INSERT INTO changes (case_id, revision, at, actor, entity, entity_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const listChanges = conn.prepare('SELECT * FROM changes WHERE case_id = ? ORDER BY change_id');
  const insertPerson = conn.prepare('INSERT INTO persons (person_id, case_id, role, ordinal, slug, label) VALUES (?, ?, ?, ?, ?, ?)');
  const deletePerson = conn.prepare('DELETE FROM persons WHERE person_id = ?');
  const updatePersonLabel = conn.prepare('UPDATE persons SET label = ? WHERE person_id = ?');
  const listPersons = conn.prepare(
    `SELECT * FROM persons WHERE case_id = ?
     ORDER BY CASE role WHEN 'hauptperson' THEN 0 WHEN 'partner' THEN 1 ELSE 2 END, ordinal`,
  );
  const maxKindOrdinal = conn.prepare(
    `SELECT COALESCE(MAX(json_extract(after, '$.ordinal')), 0) AS n FROM changes
     WHERE case_id = ? AND entity = 'person' AND action = 'create' AND json_extract(after, '$.role') = 'kind'`,
  );
  const fieldIdsWithVariant = conn.prepare('SELECT field_id FROM fields WHERE case_id = ? AND variant = ? ORDER BY field_id');

  const getImport = conn.prepare('SELECT * FROM imports WHERE package_id = ?');
  const insertImport = conn.prepare('INSERT INTO imports (package_id, case_id, imported_at, device_name, manifest_sha256) VALUES (?, ?, ?, ?, ?)');
  const insertImportFile = conn.prepare('INSERT INTO import_files (package_id, file_id, document_id, name) VALUES (?, ?, ?, ?)');
  const listImportFiles = conn.prepare(
    `SELECT f.package_id, f.file_id, f.document_id, f.name, d.sha256 FROM import_files f
     JOIN documents d ON d.document_id = f.document_id WHERE f.package_id = ? ORDER BY f.rowid`,
  );
  const insertDocument = conn.prepare(
    `INSERT INTO documents (document_id, case_id, sha256, mime, size, original_name, doc_type, status, source_device, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getDocumentBySha = conn.prepare('SELECT * FROM documents WHERE case_id = ? AND sha256 = ?');
  const listDocumentBlobs = conn.prepare('SELECT document_id, sha256, size FROM documents ORDER BY document_id');

  return {
    transaction<T>(fn: () => T): T {
      try {
        conn.exec('BEGIN IMMEDIATE');
      } catch {
        throw storageError('No se puede iniciar la transacción.');
      }
      let result: T;
      try {
        result = fn();
      } catch (e) {
        rollback(conn);
        throw e;
      }
      try {
        conn.exec('COMMIT');
      } catch {
        rollback(conn);
        throw storageError('No se puede confirmar la transacción.');
      }
      return result;
    },
    insertCase(r) {
      insertCase.run(r.case_id, r.tax_year, r.jurisdiction, r.rules_version, r.revision, r.created_at);
    },
    getCase(caseId) {
      return getCase.get(caseId) as CaseRow | undefined;
    },
    listCaseSummaries() {
      return listCaseSummaries.all() as Array<CaseRow & { hauptperson_label: string | null }>;
    },
    updateCaseHeader(caseId, taxYear, jurisdiction) {
      updateCaseHeader.run(taxYear, jurisdiction, caseId);
    },
    incrementRevision(caseId) {
      const row = incrementRevision.get(caseId) as { revision: number } | undefined;
      if (!row) throw new ExpedienteError('not_found', 'Expediente no encontrado.');
      return row.revision;
    },
    insertChange(r) {
      insertChange.run(r.case_id, r.revision, r.at, r.actor, r.entity, r.entity_id, r.action, r.before, r.after);
    },
    listChanges(caseId) {
      return listChanges.all(caseId) as ChangeRow[];
    },
    insertPerson(r) {
      insertPerson.run(r.person_id, r.case_id, r.role, r.ordinal, r.slug, r.label);
    },
    deletePerson(personId) {
      deletePerson.run(personId);
    },
    updatePersonLabel(personId, label) {
      updatePersonLabel.run(label, personId);
    },
    listPersons(caseId) {
      return listPersons.all(caseId) as PersonRow[];
    },
    maxKindOrdinal(caseId) {
      return (maxKindOrdinal.get(caseId) as { n: number }).n;
    },
    fieldIdsWithVariant(caseId, slug) {
      return (fieldIdsWithVariant.all(caseId, slug) as Array<{ field_id: string }>).map((r) => r.field_id);
    },
    getImport(packageId) {
      return getImport.get(packageId) as ImportRow | undefined;
    },
    insertImport(r) {
      insertImport.run(r.package_id, r.case_id, r.imported_at, r.device_name, r.manifest_sha256);
    },
    insertImportFile(r) {
      insertImportFile.run(r.package_id, r.file_id, r.document_id, r.name);
    },
    listImportFiles(packageId) {
      return listImportFiles.all(packageId) as Array<ImportFileRow & { sha256: string }>;
    },
    insertDocument(r) {
      insertDocument.run(r.document_id, r.case_id, r.sha256, r.mime, r.size, r.original_name, r.doc_type, r.status, r.source_device, r.imported_at);
    },
    getDocumentBySha(caseId, sha256) {
      return getDocumentBySha.get(caseId, sha256) as DocumentRow | undefined;
    },
    listDocumentBlobs() {
      return listDocumentBlobs.all() as Array<{ document_id: string; sha256: string; size: number }>;
    },
    close() {
      conn.close();
    },
  };
}
