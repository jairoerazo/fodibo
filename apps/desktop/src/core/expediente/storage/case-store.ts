import { mkdirSync } from 'node:fs';
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
  /** Ejecuta `fn` en una transacción síncrona (BEGIN IMMEDIATE); revierte si lanza. */
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
        db.exec('ROLLBACK');
        throw e;
      }
    } catch {
      throw storageError(`La migración a la versión ${m.version} del esquema ha fallado; la base sigue en la versión ${current}.`);
    }
  }
}

export function openStore(opts: OpenStoreOptions): CaseStore {
  const now = opts.now ?? (() => new Date());
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);

  let db: DatabaseSync;
  try {
    mkdirSync(opts.dir, { recursive: true });
    db = new DatabaseSync(join(opts.dir, DB_FILE));
  } catch {
    throw storageError('No se puede abrir la base del expediente.');
  }
  try {
    // Las comprobaciones de solo lectura van antes de los pragmas: una base de versión posterior no se toca.
    let integrity: string;
    let version: number;
    try {
      version = userVersion(db);
      integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    } catch {
      throw storageError('La base del expediente es ilegible.');
    }
    if (version > latest) {
      throw storageError(`La base del expediente es de una versión posterior (${version}) a la que conoce esta aplicación (${latest}).`);
    }
    if (integrity !== 'ok') throw storageError('La comprobación de integridad de la base del expediente ha fallado.');

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
        conn.exec('ROLLBACK');
        throw e;
      }
      try {
        conn.exec('COMMIT');
      } catch {
        conn.exec('ROLLBACK');
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
