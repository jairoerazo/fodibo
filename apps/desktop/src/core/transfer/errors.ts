export type ErrorCode =
  | 'invalid_secret'
  | 'unauthorized'
  | 'invalid_manifest'
  | 'unsupported_type'
  | 'too_large'
  | 'hash_mismatch'
  | 'package_conflict'
  | 'incomplete_package'
  | 'not_found'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_secret: 401,
  unauthorized: 401,
  invalid_manifest: 400,
  unsupported_type: 415,
  too_large: 413,
  hash_mismatch: 422,
  package_conflict: 409,
  incomplete_package: 409,
  not_found: 404,
  internal: 500,
};

export function httpStatusOf(code: ErrorCode): number {
  return STATUS[code];
}

export class TransferError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.status = httpStatusOf(code);
  }
}
