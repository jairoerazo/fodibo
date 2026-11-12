import type { DatabaseSync } from 'node:sqlite';
import { CANTONS, CHANGE_ENTITIES, DECL_TYPES, DOC_MIMES, DOC_STATUSES, DOC_TYPES, FIELD_ORIGINS, FIELD_STATUSES, PERSON_ROLES } from '../types.js';

export type Migration = { version: number; up(db: DatabaseSync): void };

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** Migración v1: las nueve tablas de spec §5.1, sus índices y los disparadores de solo inserción. */
const v1: Migration = {
  version: 1,
  up(db) {
    db.exec(`
CREATE TABLE cases (
  case_id TEXT NOT NULL PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN (${list(CANTONS)})),
  rules_version TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE persons (
  person_id TEXT NOT NULL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  role TEXT NOT NULL CHECK (role IN (${list(PERSON_ROLES)})),
  ordinal INTEGER NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  UNIQUE (case_id, slug)
) STRICT;
CREATE UNIQUE INDEX persons_one_hauptperson ON persons (case_id) WHERE role = 'hauptperson';
CREATE UNIQUE INDEX persons_one_partner ON persons (case_id) WHERE role = 'partner';

CREATE TABLE documents (
  document_id TEXT NOT NULL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN (${list(DOC_MIMES)})),
  size INTEGER NOT NULL CHECK (size >= 0),
  original_name TEXT NOT NULL,
  doc_type TEXT CHECK (doc_type IS NULL OR doc_type IN (${list(DOC_TYPES)})),
  status TEXT NOT NULL CHECK (status IN (${list(DOC_STATUSES)})),
  source_device TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (case_id, sha256)
) STRICT;

CREATE TABLE imports (
  package_id TEXT NOT NULL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  imported_at TEXT NOT NULL,
  device_name TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL
) STRICT;

CREATE TABLE import_files (
  package_id TEXT NOT NULL REFERENCES imports (package_id),
  file_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents (document_id),
  name TEXT NOT NULL,
  PRIMARY KEY (package_id, file_id)
) STRICT;

CREATE TABLE fields (
  field_id TEXT NOT NULL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  concept_id TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL CHECK (tipo IN (${list(DECL_TYPES)})),
  valor TEXT NOT NULL,
  moneda TEXT,
  origin TEXT NOT NULL CHECK (origin IN (${list(FIELD_ORIGINS)})),
  status TEXT NOT NULL CHECK (status IN (${list(FIELD_STATUSES)})),
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, concept_id, variant),
  CHECK ((moneda IS NOT NULL) = (tipo = 'amount'))
) STRICT;

CREATE TABLE field_evidence (
  field_id TEXT NOT NULL REFERENCES fields (field_id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents (document_id),
  page INTEGER NOT NULL CHECK (page BETWEEN 0 AND 9999),
  PRIMARY KEY (field_id, document_id, page)
) STRICT;

CREATE TABLE changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN (${list(CHANGE_ENTITIES)})),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT
) STRICT;

CREATE TABLE approvals (
  approval_id TEXT NOT NULL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases (case_id),
  case_revision INTEGER NOT NULL CHECK (case_revision >= 0),
  approved_at TEXT NOT NULL,
  approver TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  UNIQUE (case_id, case_revision)
) STRICT;

CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes
BEGIN SELECT RAISE(ABORT, 'changes es de solo inserción'); END;
CREATE TRIGGER changes_no_delete BEFORE DELETE ON changes
BEGIN SELECT RAISE(ABORT, 'changes es de solo inserción'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals es inmutable'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals es inmutable'); END;
`);
  },
};

export const MIGRATIONS: Migration[] = [v1];
