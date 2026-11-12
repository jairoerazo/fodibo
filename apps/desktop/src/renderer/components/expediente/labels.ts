import type { CaseView } from '../../../shared/expediente-ipc.js';

type Blocker = CaseView['blockers'][number];
type Warning = CaseView['warnings'][number];

/** Rótulos en español de los valores cerrados del núcleo; las claves de datos siguen en terminología suiza. */
export const CASE_STATUS_LABEL: Record<CaseView['status'], string> = {
  incompleto: 'Incompleto',
  revisable: 'Revisable',
  aprobado: 'Aprobado',
};

export const DOC_STATUS_LABEL: Record<CaseView['documents'][number]['status'], string> = {
  capturado: 'Capturado',
  extraido: 'Extraído',
  pendiente_de_revision: 'Pendiente de revisión',
  confirmado: 'Confirmado',
  descartado: 'Descartado',
};

export const DOC_TYPE_LABEL = {
  lohnausweis: 'Lohnausweis (certificado de salario)',
  bankbeleg: 'Bankbeleg (extracto bancario)',
  krankenkasse: 'Krankenkasse (seguro de salud)',
  saeule_3a: 'Säule 3a (previsión 3a)',
  quittung: 'Quittung (recibo)',
  sonstiges: 'Sonstiges (otro)',
} as const;

export const ORIGIN_LABEL: Record<CaseView['fields'][number]['origin'], string> = {
  regla: 'Regla',
  modelo: 'Modelo',
  usuario: 'Usuario',
};

export const FIELD_STATUS_LABEL: Record<CaseView['fields'][number]['status'], string> = {
  pendiente: 'Pendiente',
  confirmado: 'Confirmado',
};

export const BLOCKER_LABEL: Record<Blocker['code'], string> = {
  sin_campos: 'No hay ningún campo confirmado.',
  documento_pendiente: 'Hay un documento sin revisar.',
  campo_pendiente: 'Hay un campo pendiente de confirmar.',
  concepto_desconocido: 'Hay un campo con un concepto desconocido.',
  evidencia_no_confirmada: 'Un campo cita un documento que no está confirmado.',
  original_no_disponible: 'Falta el original de un documento citado como evidencia.',
};

export const WARNING_LABEL: Record<Warning['code'], string> = {
  sin_evidencia: 'Campo confirmado sin evidencia.',
};

/** Etiqueta de la variante de un campo: persona existente, «familie» o sin variante. */
export function variantLabel(variant: string, persons: CaseView['persons']): string {
  if (variant === '') return 'General';
  if (variant === 'familie') return 'Familie (hogar)';
  const p = persons.find((x) => x.slug === variant);
  return p ? `${p.label} (${variant})` : variant;
}

/** Valor legible: importes con su moneda, casillas como Sí/No. */
export function formatValue(f: Pick<CaseView['fields'][number], 'valor' | 'moneda'>): string {
  if (typeof f.valor === 'boolean') return f.valor ? 'Sí' : 'No';
  return f.moneda ? `${f.valor} ${f.moneda}` : f.valor;
}

export function evidenceLabel(name: string, page: number): string {
  return page === 0 ? `${name}, documento completo` : `${name}, página ${page}`;
}

/** Texto de un error del núcleo; si el almacén falló, incluye la ruta de la última copia de seguridad (spec §13). */
export function errorText(error: { code: string; message: string; details?: unknown }): string {
  const backup = (error.details as { backup?: unknown } | undefined)?.backup;
  return error.code === 'storage_error' && typeof backup === 'string' && backup
    ? `${error.message} Última copia de seguridad: ${backup}`
    : error.message;
}
