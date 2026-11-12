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

/**
 * Manipulación simulada (Ruling 5): en una conexión aparte, quita el disparador de inmutabilidad de `approvals`, reescribe
 * una columna de la última aprobación del expediente con `fn(valorActual)` y, salvo que se pida lo contrario, recrea el disparador.
 */
export function tamperApproval(dir: string, caseId: string, column: 'snapshot' | 'content_hash', fn: (current: string) => string, recreateTrigger = true): void {
  const db = openRaw(dir);
  try {
    const row = db.prepare('SELECT approval_id, snapshot, content_hash FROM approvals WHERE case_id = ? ORDER BY case_revision DESC LIMIT 1').get(caseId) as {
      approval_id: string;
      snapshot: string;
      content_hash: string;
    };
    db.exec('DROP TRIGGER approvals_no_update');
    db.prepare(`UPDATE approvals SET ${column} = ? WHERE approval_id = ?`).run(fn(row[column]), row.approval_id);
    if (recreateTrigger) {
      db.exec("CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'approvals es inmutable'); END;");
    }
  } finally {
    db.close();
  }
}

/** Última aprobación del expediente tal como está en la base (lectura directa para las pruebas). */
export function readApproval(dir: string, caseId: string): { approval_id: string; case_revision: number; content_hash: string; snapshot: string } | undefined {
  const db = openRaw(dir);
  try {
    return db.prepare('SELECT approval_id, case_revision, content_hash, snapshot FROM approvals WHERE case_id = ? ORDER BY case_revision DESC LIMIT 1').get(caseId) as
      | { approval_id: string; case_revision: number; content_hash: string; snapshot: string }
      | undefined;
  } finally {
    db.close();
  }
}
