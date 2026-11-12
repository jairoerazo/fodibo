import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../case-store.js';

/** Directorio temporal para una base de pruebas. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fodibo-store-'));
}

/** Conexión de SQL crudo a la base de `dir` (con claves foráneas, como el almacén). Única vía de SQL crudo en pruebas. */
export function openRaw(dir: string): DatabaseSync {
  const db = new DatabaseSync(join(dir, DB_FILE));
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
