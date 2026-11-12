import type { DeclType } from '../agent/types.js';
import type { Mime } from '../transfer/types.js';

export const CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
] as const;
export type Canton = (typeof CANTONS)[number];

export const PERSON_ROLES = ['hauptperson', 'partner', 'kind'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const DOC_STATUSES = ['capturado', 'extraido', 'pendiente_de_revision', 'confirmado', 'descartado'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const DOC_TYPES = ['lohnausweis', 'bankbeleg', 'krankenkasse', 'saeule_3a', 'quittung', 'sonstiges'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const FIELD_ORIGINS = ['regla', 'modelo', 'usuario'] as const;
export type FieldOrigin = (typeof FIELD_ORIGINS)[number];

export const FIELD_STATUSES = ['pendiente', 'confirmado'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const CHANGE_ENTITIES = ['case', 'person', 'document', 'field', 'import', 'approval'] as const;
export type ChangeEntity = (typeof CHANGE_ENTITIES)[number];

export const DOC_MIMES = ['image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'application/json'] as const satisfies readonly Mime[];

/** Tipos de valor de un campo (los de la declaración). */
export const DECL_TYPES = ['text', 'date', 'amount', 'iban', 'enum', 'boolean'] as const satisfies readonly DeclType[];

/** Actor único de esta versión. */
export const ACTOR_LOCAL = 'usuario:local';

export type Evidence = { documentId: string; page: number };

export type CaseRow = {
  case_id: string;
  tax_year: number;
  jurisdiction: Canton;
  rules_version: string | null;
  revision: number;
  created_at: string;
};

export type PersonRow = {
  person_id: string;
  case_id: string;
  role: PersonRole;
  ordinal: number;
  slug: string;
  label: string;
};

export type DocumentRow = {
  document_id: string;
  case_id: string;
  sha256: string;
  mime: Mime;
  size: number;
  original_name: string;
  doc_type: DocType | null;
  status: DocStatus;
  source_device: string;
  imported_at: string;
};

export type ImportRow = {
  package_id: string;
  case_id: string;
  imported_at: string;
  device_name: string;
  manifest_sha256: string;
};

export type ImportFileRow = {
  package_id: string;
  file_id: string;
  document_id: string;
  name: string;
};

export type FieldRow = {
  field_id: string;
  case_id: string;
  concept_id: string;
  variant: string;
  tipo: DeclType;
  valor: string;
  moneda: string | null;
  origin: FieldOrigin;
  status: FieldStatus;
  updated_at: string;
};

export type FieldEvidenceRow = { field_id: string; document_id: string; page: number };

export type ChangeRow = {
  change_id: number;
  case_id: string;
  revision: number;
  at: string;
  actor: string;
  entity: ChangeEntity;
  entity_id: string;
  action: string;
  before: string | null;
  after: string | null;
};

export type ApprovalRow = {
  approval_id: string;
  case_id: string;
  case_revision: number;
  approved_at: string;
  approver: string;
  content_hash: string;
  snapshot: string;
};
