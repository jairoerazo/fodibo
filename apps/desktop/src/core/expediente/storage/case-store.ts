import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExpedienteError } from '../errors.js';
import type { CaseRow } from '../types.js';
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
    close() {
      conn.close();
    },
  };
}
