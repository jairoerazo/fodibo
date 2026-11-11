export type FieldType = 'text' | 'date' | 'amount' | 'iban' | 'select' | 'checkbox';
export type DeclType = 'text' | 'date' | 'amount' | 'iban' | 'enum' | 'boolean';

export interface DeclEntry {
  tipo: DeclType;
  valor: string | boolean;
  moneda?: string;
}
export type Declaration = Record<string, DeclEntry>;

export interface ObservedField {
  field_id: string;
  label: string;
  help: string;
  type: FieldType;
  options?: string[];
  required: boolean;
  value: string;
}
export interface ObservedStep {
  index: number;
  total: number;
  title: string;
  isSummary: boolean;
  fields: ObservedField[];
  errors: string[];
}
export interface PortalAdapter {
  observarPaso(): Promise<ObservedStep>;
  rellenarCampo(fieldId: string, valor: string): Promise<void>;
  leerCampo(fieldId: string): Promise<string>;
  avanzarPaso(): Promise<void>;
}

export type PendingReason =
  | 'sin_dato'
  | 'ambiguo'
  | 'tipo_incompatible'
  | 'no_verificado'
  | 'valor_previo_distinto'
  | 'modelo_sin_respuesta'
  | 'error_portal';

export type FieldOutcome =
  | { kind: 'filled'; source: string; written: string }
  | { kind: 'prefilled_ok' }
  | { kind: 'skipped' }
  | { kind: 'pending'; reason: PendingReason; detail?: string; candidates: { key: string; valor: string }[] };

export interface FieldResult {
  step: number;
  stepTitle: string;
  field_id: string;
  label: string;
  required: boolean;
  outcome: FieldOutcome;
}
