import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;

/// Huella `sha256:<hex en minúsculas>` de un certificado en DER.
String certificateFingerprint(List<int> der) => 'sha256:${crypto.sha256.convert(der)}';

/// `HttpClient` que solo acepta el certificado cuya huella es [fingerprint].
///
/// Sin raíces de confianza, todo certificado pasa por `badCertificateCallback`,
/// que lo acepta solo si su huella coincide (con independencia del host). La
/// comparación es una igualdad de cadenas: la huella no es secreta (va en el
/// QR), así que no hace falta comparación en tiempo constante.
/// [onMismatch] se llama cuando se rechaza un certificado, para distinguir este
/// caso de otros fallos de TLS. Nunca usa proxy: la conexión es siempre directa
/// dentro de la LAN.
HttpClient createPinnedHttpClient(String fingerprint, {void Function()? onMismatch}) {
  return HttpClient(context: SecurityContext(withTrustedRoots: false))
    ..connectionTimeout = const Duration(seconds: 3)
    ..findProxy = ((_) => 'DIRECT')
    ..badCertificateCallback = (cert, host, port) {
      final ok = certificateFingerprint(cert.der) == fingerprint;
      if (!ok) onMismatch?.call();
      return ok;
    };
}
