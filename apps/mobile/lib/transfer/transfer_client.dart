import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'contracts.dart';
import 'errors.dart';
import 'local_file.dart';
import 'pinned_client.dart';

typedef Sleep = Future<void> Function(Duration);

/// Cliente del protocolo v1 (spec §6) sobre HTTPS con certificado fijado.
class TransferClient {
  /// Esperas entre reintentos ante errores de red o 5xx.
  static const retryDelays = [
    Duration(seconds: 1),
    Duration(seconds: 2),
    Duration(seconds: 4),
    Duration(seconds: 8),
  ];

  /// Espera máxima de una respuesta y de progreso en una subida: sin ella, una
  /// Wi-Fi caída dejaría la petición colgada en lugar de reintentar.
  static const _timeout = Duration(seconds: 30);

  final HttpClient _http;
  final Uri _base;
  final String _token;
  final String _deviceName;
  final DateTime Function() _now;
  final Sleep _sleep;

  /// Manifiestos ya anunciados: reenviar el mismo `packageId` debe anunciar
  /// exactamente el mismo manifiesto (mismos `file_id` y `created_at`).
  final _manifests = <String, Manifest>{};

  TransferClient._(this._http, this._base, this._token, this._deviceName, this._now, this._sleep);

  /// Empareja con el PC del QR. Prueba cada host en orden; una huella distinta
  /// corta sin probar más hosts.
  static Future<TransferClient> connect(
    QrPayload qr, {
    required String deviceName,
    DateTime Function()? now,
    Sleep? sleep,
  }) async {
    final clock = now ?? DateTime.now;
    if (clock().isAfter(qr.exp)) {
      throw const TransferException('expired_qr', 'El código QR ha caducado');
    }
    for (final host in qr.hosts) {
      var mismatch = false;
      final http = createPinnedHttpClient(qr.fp, onMismatch: () => mismatch = true);
      final base = Uri(scheme: 'https', host: host, port: qr.port);
      try {
        final body = await _call(http, 'POST', base.resolve('/v1/pair'),
            json: {'secret': qr.secret, 'device_name': deviceName},
            unauthorizedCode: 'invalid_secret');
        final token = body is Map ? body['session_token'] : null;
        if (token is! String) {
          throw const TransferException('invalid_response', 'Respuesta de emparejado inválida');
        }
        return TransferClient._(
            http, base, token, deviceName, clock, sleep ?? Future<void>.delayed);
      } on _Retryable catch (e) {
        http.close(force: true);
        if (mismatch) {
          throw const TransferException(
              'fingerprint_mismatch', 'El certificado del PC no coincide con el del QR');
        }
        if (e.status != null) throw e.toException(); // 5xx: el PC respondió
      } catch (_) {
        http.close(force: true);
        rethrow;
      }
    }
    throw const TransferException('unreachable', 'No se pudo conectar con el PC');
  }

  /// Anuncia, sube solo lo que falta y confirma. Reintenta errores de red y 5xx
  /// (volviendo a anunciar); los rechazos definitivos de un archivo llevan su hash.
  ///
  /// Si tras los reintentos el PC sigue rechazando la conexión (puerto
  /// cerrado: «Detener», inactividad, QR regenerado), lanza `session_closed`:
  /// el servidor solo escucha mientras hay sesión (spec §6).
  Future<Receipt> send(
    List<LocalFile> files, {
    String? packageId,
    void Function(String sha256, int sent, int total)? onProgress,
  }) async {
    final manifest = _manifestFor(packageId ?? newUuidV4(), files);
    final mismatches = <String, int>{};
    var retries = 0;
    while (true) {
      try {
        return await _attempt(manifest, files, mismatches, onProgress);
      } on _Retryable catch (e) {
        if (retries == retryDelays.length) {
          if (e.refused) {
            throw TransferException('session_closed', 'El PC cerró la sesión: ${e.message}');
          }
          throw e.toException();
        }
        await _sleep(retryDelays[retries++]);
      }
    }
  }

  void close() => _http.close(force: true);

  Manifest _manifestFor(String packageId, List<LocalFile> files) {
    final prev = _manifests[packageId];
    bool same(ManifestFile m, LocalFile f) =>
        m.name == f.name && m.mime == f.mime && m.size == f.size && m.sha256 == f.sha256;
    if (prev != null &&
        prev.files.length == files.length &&
        Iterable.generate(files.length).every((i) => same(prev.files[i], files[i]))) {
      return prev;
    }
    return _manifests[packageId] = Manifest(
      packageId: packageId,
      createdAt: _now().toUtc().copyWith(millisecond: 0, microsecond: 0).toIso8601String(),
      deviceName: _deviceName,
      files: [
        for (final f in files)
          ManifestFile(
              fileId: newUuidV4(), name: f.name, mime: f.mime, size: f.size, sha256: f.sha256),
      ],
    );
  }

  Future<Receipt> _attempt(
    Manifest manifest,
    List<LocalFile> files,
    Map<String, int> mismatches,
    void Function(String, int, int)? onProgress,
  ) async {
    final pkg = manifest.packageId;
    final announced = await _authed('POST', '/v1/packages', json: manifest.toJson());
    final missingRaw = announced is Map ? announced['missing'] : null;
    if (missingRaw is! List || missingRaw.any((s) => s is! String)) {
      throw const TransferException('invalid_response', 'Respuesta de anuncio inválida');
    }
    final missing = missingRaw.cast<String>().toSet();
    final bySha = {for (final f in files.reversed) f.sha256: f};
    if (!bySha.keys.toSet().containsAll(missing)) {
      throw const TransferException('invalid_response', 'El PC pide un archivo desconocido');
    }
    for (final f in bySha.values) {
      if (!missing.contains(f.sha256)) onProgress?.call(f.sha256, f.size, f.size);
    }

    for (final sha in missing) {
      final file = bySha[sha]!;
      while (true) {
        try {
          await _authed('PUT', '/v1/packages/$pkg/files/$sha',
              file: file, onSent: (n) => onProgress?.call(sha, n, file.size));
          break;
        } on TransferException catch (e) {
          final mismatch = e.code == 'hash_mismatch';
          if (mismatch && (mismatches[sha] = (mismatches[sha] ?? 0) + 1) < 2) continue;
          if (e.code == 'session_closed') rethrow;
          throw TransferException(e.code, e.message, sha);
        }
      }
    }

    final receipt = await _authed('POST', '/v1/packages/$pkg/commit');
    try {
      if (receipt is! Map<String, Object?>) throw const FormatException('no es un objeto');
      return Receipt.fromJson(receipt);
    } on Object catch (e) {
      throw TransferException('invalid_response', 'Recibo inválido: $e');
    }
  }

  Future<Object?> _authed(String method, String path,
          {Object? json, LocalFile? file, void Function(int)? onSent}) =>
      _call(_http, method, _base.resolve(path),
          token: _token, json: json, file: file, onSent: onSent);

  /// Hace una petición y devuelve el JSON de la respuesta 2xx (null si no hay
  /// cuerpo). Lanza `_Retryable` ante errores de red o 5xx y
  /// `TransferException` con el `error.code` del servidor en los demás casos.
  static Future<Object?> _call(
    HttpClient http,
    String method,
    Uri uri, {
    String? token,
    Object? json,
    LocalFile? file,
    void Function(int sent)? onSent,
    String unauthorizedCode = 'session_closed',
  }) async {
    final int status;
    final String? text; // null: el cuerpo no es UTF-8
    try {
      final req = await http.openUrl(method, uri);
      if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (json != null) {
        final bytes = utf8.encode(jsonEncode(json));
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      } else if (file != null) {
        req.headers.contentType = ContentType.binary;
        req.contentLength = file.size;
        await _upload(req, file, onSent);
      } else {
        req.contentLength = 0;
      }
      final res = await req.close().timeout(_timeout);
      status = res.statusCode;
      final bytes = await res
          .fold<BytesBuilder>(BytesBuilder(copy: false), (b, chunk) => b..add(chunk))
          .timeout(_timeout);
      text = _utf8OrNull(bytes.takeBytes());
    } on SocketException catch (e) {
      throw _Retryable(e.toString(), refused: _isRefused(e));
    } on IOException catch (e) {
      throw _Retryable(e.toString());
    } on TimeoutException catch (e) {
      throw _Retryable(e.toString());
    }

    Object? body;
    try {
      if (text == null) throw const FormatException('no es UTF-8');
      body = text.isEmpty ? null : jsonDecode(text);
    } on FormatException {
      body = null;
      if (status >= 200 && status < 300) {
        throw const TransferException('invalid_response', 'Respuesta no es JSON');
      }
    }
    if (status >= 200 && status < 300) return body;

    final error = body is Map ? body['error'] : null;
    final code = error is Map && error['code'] is String ? error['code'] as String : 'http_$status';
    final message = error is Map && error['message'] is String ? error['message'] as String : '';
    if (status >= 500) throw _Retryable(message, status: status, code: code);
    if (status == 401) throw TransferException(unauthorizedCode, message);
    throw TransferException(code, message);
  }

  static String? _utf8OrNull(List<int> bytes) {
    try {
      return utf8.decode(bytes);
    } on FormatException {
      return null;
    }
  }

  /// Conexión rechazada: el host responde pero el puerto está cerrado
  /// (ECONNREFUSED: 61 en macOS/iOS, 111 en Linux/Android, 10061 en Windows).
  static bool _isRefused(SocketException e) {
    final errno = e.osError?.errorCode;
    if (errno == 61 || errno == 111 || errno == 10061) return true;
    final text = '${e.message} ${e.osError?.message ?? ''}'.toLowerCase();
    return text.contains('connection refused');
  }

  /// Sube el archivo en streaming; aborta si deja de avanzar durante [_timeout].
  static Future<void> _upload(
      HttpClientRequest req, LocalFile file, void Function(int)? onSent) async {
    var sent = 0;
    Timer? stall;
    void arm() {
      stall?.cancel();
      stall = Timer(_timeout, () => req.abort(TimeoutException('Subida detenida', _timeout)));
    }

    arm();
    try {
      // Solo los `size` bytes anunciados: si el archivo cambió, el PC lo
      // detecta como `hash_mismatch` en lugar de un cuerpo de longitud errónea.
      await req.addStream(File(file.path).openRead(0, file.size).map((chunk) {
        arm();
        sent += chunk.length;
        onSent?.call(sent);
        return chunk;
      }));
    } finally {
      stall?.cancel();
    }
  }
}

/// Fallo transitorio (red o 5xx): se reintenta.
class _Retryable implements Exception {
  final String message;
  final int? status;
  final String? code;

  /// Conexión rechazada (puerto cerrado), no una red caída.
  final bool refused;
  _Retryable(this.message, {this.status, this.code, this.refused = false});

  TransferException toException() => status == null
      ? TransferException('unreachable', message)
      : TransferException(code ?? 'http_$status', message);
}
