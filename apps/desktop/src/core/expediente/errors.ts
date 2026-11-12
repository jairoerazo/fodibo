/** Códigos estables del núcleo del expediente (spec §13). */
export const EXPEDIENTE_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'storage_error',
  'package_incomplete',
  'package_invalid',
  'package_in_other_case',
  'integrity_error',
  'invalid_transition',
  'person_in_use',
  'stale_revision',
  'blocked',
  'no_approval',
  'approval_stale',
  'approval_corrupt',
] as const;

export type ExpedienteErrorCode = (typeof EXPEDIENTE_ERROR_CODES)[number];

/** Error del núcleo: el mensaje va en español y nunca incluye valores de campos ni nombres de archivo. */
export class ExpedienteError extends Error {
  constructor(
    readonly code: ExpedienteErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExpedienteError';
  }
}
