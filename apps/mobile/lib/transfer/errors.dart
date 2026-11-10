/// Error del cliente de transferencia.
///
/// `code` usa los códigos del contrato (`invalid_secret`, `unauthorized`,
/// `invalid_manifest`, `unsupported_type`, `too_large`, `hash_mismatch`,
/// `package_conflict`, `incomplete_package`, `not_found`) más los del cliente:
/// `fingerprint_mismatch`, `unreachable`, `expired_qr`, `invalid_qr`,
/// `session_closed`, `invalid_response` (respuesta del PC que no cumple el
/// contrato).
class TransferException implements Exception {
  final String code;
  final String message;

  /// SHA-256 del archivo culpable en los rechazos definitivos de un archivo
  /// (`unsupported_type`, `too_large`, `hash_mismatch`).
  final String? fileSha256;

  const TransferException(this.code, [this.message = '', this.fileSha256]);

  @override
  String toString() {
    final file = fileSha256 == null ? '' : ' [$fileSha256]';
    return message.isEmpty
        ? 'TransferException($code)$file'
        : 'TransferException($code)$file: $message';
  }
}
