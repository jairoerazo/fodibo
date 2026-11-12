import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ExpedienteError } from '../../errors.js';
import type { CaseRow } from '../../types.js';
import { DB_FILE, MIGRATIONS, openStore, type CaseStore } from '../index.js';
import { openRaw, tempDir } from './helpers.js';

const TABLES = ['approvals', 'cases', 'changes', 'documents', 'field_evidence', 'fields', 'import_files', 'imports', 'persons'];
const T0 = '2026-11-12T10:00:00.000Z';
const SHA_A = 'a'.repeat(64);

const caseRow = (id = 'c1'): CaseRow => ({ case_id: id, tax_year: 2025, jurisdiction: 'ZH', rules_version: null, revision: 0, created_at: T0 });

describe('almacén SQLite', () => {
  const stores: CaseStore[] = [];
  const raws: DatabaseSync[] = [];
  const open = (dir: string, extra: Partial<Parameters<typeof openStore>[0]> = {}): CaseStore => {
    const s = openStore({ dir, ...extra });
    stores.push(s);
    return s;
  };
  const raw = (dir: string): DatabaseSync => {
    const r = openRaw(dir);
    raws.push(r);
    return r;
  };
  afterEach(() => {
    for (const r of raws.splice(0)) if (r.isOpen) r.close();
    for (const s of stores.splice(0)) {
      try {
        s.close();
      } catch {
        /* ya cerrado */
      }
    }
  });

  const seed = (db: DatabaseSync): void => {
    db.prepare('INSERT INTO cases VALUES (?, 2025, ?, NULL, 0, ?)').run('c1', 'ZH', T0);
  };
  const insertDoc = (db: DatabaseSync, id: string, sha: string, status = 'confirmado'): void => {
    db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, 10, ?, NULL, ?, ?, ?)').run(id, 'c1', sha, 'application/pdf', 'x.pdf', status, 'tel', T0);
  };
  const insertField = (db: DatabaseSync, id: string, concept: string, variant: string, tipo: string, moneda: string | null, origin = 'usuario', status = 'pendiente'): void => {
    db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'c1', concept, variant, tipo, '1.00', moneda, origin, status, T0);
  };

  it('crea el esquema v1 con las 9 tablas STRICT', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    expect(rows.map((r) => r.name)).toEqual(TABLES);
    for (const r of rows) expect(r.sql, r.name).toMatch(/\)\s*STRICT\s*$/);
  });

  it('restricciones de documents y fields', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    seed(db);
    insertDoc(db, 'd1', SHA_A);
    expect(() => insertDoc(db, 'd2', SHA_A)).toThrow(/UNIQUE/);
    expect(() => insertDoc(db, 'd3', 'b'.repeat(64), 'borrado')).toThrow(/CHECK/);

    insertField(db, 'f1', 'lohn', '', 'text', null);
    expect(() => insertField(db, 'f2', 'lohn', '', 'text', null)).toThrow(/UNIQUE/);
    expect(() => insertField(db, 'f3', 'x', '', 'text', null, 'robot')).toThrow(/CHECK/);
    expect(() => insertField(db, 'f4', 'x', '', 'text', null, 'regla', 'listo')).toThrow(/CHECK/);
    expect(() => insertField(db, 'f5', 'x', '', 'amount', null)).toThrow(/CHECK/);
    expect(() => insertField(db, 'f6', 'x', '', 'text', 'CHF')).toThrow(/CHECK/);
    insertField(db, 'f7', 'x', '', 'amount', 'CHF');
  });

  it('restricciones de persons: rol, una hauptperson y como mucho un partner', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    seed(db);
    const person = (id: string, role: string, ordinal: number, slug: string): void => {
      db.prepare('INSERT INTO persons VALUES (?, ?, ?, ?, ?, ?)').run(id, 'c1', role, ordinal, slug, 'Anna');
    };
    person('p1', 'hauptperson', 0, 'hauptperson');
    expect(() => person('p2', 'hauptperson', 1, 'hauptperson2')).toThrow(/UNIQUE/);
    expect(() => person('p3', 'padre', 1, 'padre')).toThrow(/CHECK/);
    person('p4', 'partner', 1, 'partner');
    expect(() => person('p5', 'partner', 2, 'partner2')).toThrow(/UNIQUE/);
    person('p6', 'kind', 1, 'kind_1');
    person('p7', 'kind', 2, 'kind_2');
  });

  it('las claves foráneas están activas', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    seed(db);
    insertField(db, 'f1', 'x', '', 'text', null);
    expect(() => db.prepare('INSERT INTO field_evidence VALUES (?, ?, 1)').run('f1', 'no-existe')).toThrow(/FOREIGN KEY/);
    insertDoc(db, 'd1', SHA_A);
    db.prepare('INSERT INTO field_evidence VALUES (?, ?, 1)').run('f1', 'd1');
    // Borrar el campo arrastra su evidencia.
    db.prepare('DELETE FROM fields WHERE field_id = ?').run('f1');
    expect((db.prepare('SELECT count(*) AS n FROM field_evidence').get() as { n: number }).n).toBe(0);
  });

  it('changes y approvals son solo inserción', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    seed(db);
    db.prepare("INSERT INTO changes (case_id, revision, at, actor, entity, entity_id, action, before, after) VALUES ('c1', 1, ?, 'usuario:local', 'case', 'c1', 'create', NULL, NULL)").run(T0);
    db.prepare("INSERT INTO approvals VALUES ('a1', 'c1', 0, ?, 'usuario:local', 'h', '{}')").run(T0);
    expect(() => db.exec("UPDATE changes SET action = 'x'")).toThrow(/solo inserción/);
    expect(() => db.exec('DELETE FROM changes')).toThrow(/solo inserción/);
    expect(() => db.exec("UPDATE approvals SET content_hash = 'x'")).toThrow(/inmutable/);
    expect(() => db.exec('DELETE FROM approvals')).toThrow(/inmutable/);
    expect(() => db.prepare("INSERT INTO approvals VALUES ('a2', 'c1', 0, ?, 'u', 'h', '{}')").run(T0)).toThrow(/UNIQUE/);
  });

  it('revision y case_revision no admiten negativos', () => {
    const dir = tempDir();
    open(dir);
    const db = raw(dir);
    expect(() => db.prepare('INSERT INTO cases VALUES (?, 2025, ?, NULL, -1, ?)').run('c9', 'ZH', T0)).toThrow(/CHECK/);
    seed(db);
    expect(() => db.prepare("INSERT INTO approvals VALUES ('a1', 'c1', -1, ?, 'u', 'h', '{}')").run(T0)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO changes (case_id, revision, at, actor, entity, entity_id, action) VALUES ('c1', -1, ?, 'u', 'case', 'c1', 'x')").run(T0)).toThrow(/CHECK/);
  });

  it('migración con copia previa; si falla, queda en la versión anterior y la base abre', () => {
    const dir = tempDir();
    open(dir).close();
    const v2 = { version: 2, up: (db: DatabaseSync) => db.exec('CREATE TABLE extra (id TEXT NOT NULL PRIMARY KEY) STRICT') };
    const mig = [MIGRATIONS[0]!, v2];
    const s = open(dir, { migrations: mig, now: () => new Date('2026-11-12T10:00:00.000Z') });
    s.close();
    const backups = readdirSync(join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^fodibo-v1-.*\.db$/);
    const db = raw(dir);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    // La copia es una base v1 completa, sin la tabla nueva.
    const copy = new DatabaseSync(join(dir, 'backups', backups[0]!), { readOnly: true });
    expect((copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").all()).toHaveLength(0);
    copy.close();
  });

  it('una migración que falla no cambia user_version ni deja la base inservible', () => {
    const dir = tempDir();
    open(dir).close();
    const bad = {
      version: 2,
      up: (db: DatabaseSync) => {
        db.exec('CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT');
        throw new Error('boom con datos secretos');
      },
    };
    let err: unknown;
    try {
      open(dir, { migrations: [MIGRATIONS[0]!, bad] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpedienteError);
    expect((err as ExpedienteError).code).toBe('storage_error');
    expect((err as ExpedienteError).message).not.toMatch(/secretos/);
    const db = raw(dir);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").all()).toHaveLength(0);
    db.close();
    // Sigue abriéndose con el conjunto de migraciones normal.
    const s = open(dir);
    s.insertCase(caseRow());
    expect(s.getCase('c1')?.jurisdiction).toBe('ZH');
  });

  it('una base nueva no genera copia', () => {
    const dir = tempDir();
    open(dir);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('rechaza una base de versión posterior sin modificarla', () => {
    const dir = tempDir();
    const file = join(dir, DB_FILE);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();
    const before = statSync(file);
    let err: unknown;
    try {
      openStore({ dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpedienteError);
    expect((err as ExpedienteError).code).toBe('storage_error');
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readdirSync(dir)).toEqual([DB_FILE]);
  });

  it('rechaza una base WAL de versión posterior con -wal caliente sin tocar ningún archivo', () => {
    const dir = tempDir();
    const file = join(dir, DB_FILE);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.exec('CREATE TABLE t (x TEXT) STRICT; INSERT INTO t VALUES (\'a\')');
    db.exec('PRAGMA user_version = 99');
    // Simula un cierre brusco: se copian los archivos mientras el -wal está caliente.
    const copy = tempDir();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(file + suffix)) writeFileSync(join(copy, DB_FILE + suffix), readFileSync(file + suffix));
    }
    db.close();
    // -shm es solo el índice volátil del WAL (se reconstruye al leer): no cuenta como modificación de datos.
    const snap = (): Record<string, string> =>
      Object.fromEntries(
        [DB_FILE, `${DB_FILE}-wal`].map((n) => [n, `${statSync(join(copy, n)).size}:${statSync(join(copy, n)).mtimeMs}:${readFileSync(join(copy, n)).toString('base64')}`]),
      );
    expect(readdirSync(copy)).toContain(`${DB_FILE}-wal`);
    const before = snap();
    let err: unknown;
    try {
      openStore({ dir: copy });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExpedienteError);
    expect((err as ExpedienteError).code).toBe('storage_error');
    expect(snap()).toEqual(before);
  });

  it('si SQLite ya revirtió por su cuenta, el error original sigue saliendo', () => {
    const dir = tempDir();
    const s = open(dir);
    // RAISE(ROLLBACK) revierte la transacción dentro de SQLite, como ocurre con SQLITE_FULL o errores de E/S.
    raw(dir).exec("CREATE TRIGGER boom BEFORE INSERT ON cases WHEN NEW.case_id = 'boom' BEGIN SELECT RAISE(ROLLBACK, 'revertida'); END");
    let err: unknown;
    try {
      s.transaction(() => {
        s.insertCase(caseRow('antes'));
        s.insertCase(caseRow('boom'));
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error).message)).toMatch(/revertida/);
    expect(String((err as Error).message)).not.toMatch(/no transaction/);
    expect(s.getCase('antes')).toBeUndefined();
    // El almacén sigue utilizable.
    expect(s.transaction(() => 1)).toBe(1);
  });

  it('transaction confirma el resultado y revierte si fn lanza', () => {
    const dir = tempDir();
    const s = open(dir);
    expect(s.transaction(() => {
      s.insertCase(caseRow('ok'));
      return 7;
    })).toBe(7);
    expect(() =>
      s.transaction(() => {
        s.insertCase(caseRow('malo'));
        throw new ExpedienteError('invalid_input', 'no');
      }),
    ).toThrow(ExpedienteError);
    expect(s.getCase('ok')).toBeDefined();
    expect(s.getCase('malo')).toBeUndefined();
  });
});
