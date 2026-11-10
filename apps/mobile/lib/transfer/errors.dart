/// Error del cliente de transferencia.
///
/// `code` usa los códigos del contrato (`invalid_secret`, `unauthorized`,
/// `invalid_manifest`, `unsupported_type`, `too_large`, `hash_mismatch`,
/// `package_conflict`, `incomplete_package`, `not_found`) más los del cliente:
/// `fingerprint_mismatch`, `unreachable`, `expired_qr`, `invalid_qr`,
/// `session_closed`.
class TransferException implements Exception {
  final String code;
  final String message;

  const TransferException(this.code, [this.message = '']);

  @override
  String toString() =>
      message.isEmpty ? 'TransferException($code)' : 'TransferException($code): $message';
}
