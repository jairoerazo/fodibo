import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:fodibo_transfer/transfer/contracts.dart';

const fixtures = 'test/fixtures';

/// Huella `sha256:<hex>` del certificado PEM indicado (DER = base64 del PEM).
String fingerprintOfPem(String pemPath) {
  final b64 = File(pemPath)
      .readAsLinesSync()
      .where((l) => !l.startsWith('-----'))
      .join();
  return 'sha256:${crypto.sha256.convert(base64.decode(b64))}';
}

/// Servidor `/v1` en memoria sobre HTTPS (TLS 1.3, `server.pem`) con ganchos
/// para inyectar fallos.
class FakeServer {
  final HttpServer _server;
  final String secret;

  /// Peticiones HTTP recibidas (cualquier ruta).
  int requests = 0;
  int announces = 0;

  /// `PUT` recibidos por hash (incluidos los cortados o rechazados).
  final putCount = <String, int>{};

  /// Hashes almacenados por paquete.
  final stored = <String, Map<String, Uint8List>>{};
  final _manifests = <String, String>{};
  final _receipts = <String, Map<String, Object?>>{};
  String? _token;

  // ---- Ganchos ----

  /// Corta la conexión tras recibir N bytes del `PUT` de ese hash (una vez).
  final cutPutAfterBytes = <String, int>{};

  /// Responde 500 una vez en la siguiente petición de ese tipo
  /// (`announce`, `put`, `commit`).
  final fail500Once = <String>{};

  /// Rechaza el `PUT` de ese hash con este código de error (siempre).
  final rejectPut = <String, String>{};

  /// Hashes que el servidor «ya tiene»: no aparecen en `missing`.
  final alreadyHave = <String>{};

  FakeServer._(this._server, this.secret) {
    _server.listen(_handle);
  }

  static Future<FakeServer> start({String secret = 'AAAAAAAAAAAAAAAAAAAAAA'}) async {
    final ctx = SecurityContext()
      ..useCertificateChain('$fixtures/server.pem')
      ..usePrivateKey('$fixtures/server.key');
    final server = await HttpServer.bindSecure('127.0.0.1', 0, ctx);
    return FakeServer._(server, secret);
  }

  int get port => _server.port;

  /// Simula «Detener» en el PC: el token deja de valer.
  void revokeSession() => _token = null;

  QrPayload qr({List<String>? hosts, String? fp, DateTime? exp}) => QrPayload(
        hosts: hosts ?? ['127.0.0.1'],
        port: port,
        fp: fp ?? fingerprintOfPem('$fixtures/server.pem'),
        secret: secret,
        exp: exp ?? DateTime.now().toUtc().add(const Duration(minutes: 5)),
      );

  Future<void> close() => _server.close(force: true);

  Future<void> _handle(HttpRequest req) async {
    requests++;
    try {
      try {
        await _route(req);
      } on FormatException {
        throw _Err(400, 'invalid_manifest');
      }
    } on _Err catch (e) {
      try {
        await req.drain<void>(); // si el cuerpo aún no se leyó
      } catch (_) {}
      await _json(req.response, e.status, {
        'error': {'code': e.code, 'message': e.code}
      });
    }
  }

  Future<void> _route(HttpRequest req) async {
    final path = req.uri.path;
    if (req.method == 'POST' && path == '/v1/pair') {
      final body = await _readJson(req);
      if (body['secret'] != secret) throw _Err(401, 'invalid_secret');
      _token = 'tok-${DateTime.now().microsecondsSinceEpoch}';
      return _json(req.response, 200, {'session_token': _token});
    }
    final auth = req.headers.value(HttpHeaders.authorizationHeader);
    if (_token == null || auth != 'Bearer $_token') throw _Err(401, 'unauthorized');

    final put = RegExp(r'^/v1/packages/([0-9a-f-]{36})/files/([0-9a-f]{64})$')
        .firstMatch(path);
    final commit = RegExp(r'^/v1/packages/([0-9a-f-]{36})/commit$').firstMatch(path);
    if (req.method == 'POST' && path == '/v1/packages') {
      announces++;
      _maybe500('announce');
      return _announce(req);
    } else if (req.method == 'PUT' && put != null) {
      return _put(req, put[1]!, put[2]!);
    } else if (req.method == 'POST' && commit != null) {
      _maybe500('commit');
      return _commit(req, commit[1]!);
    }
    throw _Err(404, 'not_found');
  }

  void _maybe500(String kind) {
    if (fail500Once.remove(kind)) throw _Err(500, 'internal');
  }

  Future<void> _announce(HttpRequest req) async {
    final raw = await _readJson(req);
    final m = Manifest.fromJson(raw);
    final canonical = jsonEncode(raw);
    final prev = _manifests[m.packageId];
    if (prev != null && prev != canonical) throw _Err(409, 'package_conflict');
    _manifests[m.packageId] = canonical;
    final have = stored.putIfAbsent(m.packageId, () => {});
    final missing = _receipts.containsKey(m.packageId)
        ? <String>[]
        : {
            for (final f in m.files)
              if (!have.containsKey(f.sha256) && !alreadyHave.contains(f.sha256))
                f.sha256
          }.toList();
    _json(req.response, 200, {'package_id': m.packageId, 'missing': missing});
  }

  Future<void> _put(HttpRequest req, String pkg, String sha) async {
    putCount[sha] = (putCount[sha] ?? 0) + 1;
    final manifest = _manifests[pkg];
    if (manifest == null) throw _Err(404, 'not_found');
    final declared = Manifest.fromJson(jsonDecode(manifest) as Map<String, Object?>)
        .files
        .firstWhere((f) => f.sha256 == sha, orElse: () => throw _Err(404, 'not_found'));

    final cut = cutPutAfterBytes.remove(sha);
    final body = BytesBuilder(copy: false);
    if (cut != null) {
      final done = Completer<void>();
      late StreamSubscription<List<int>> sub;
      sub = req.listen((chunk) async {
        body.add(chunk);
        if (body.length >= cut && !done.isCompleted) {
          done.complete();
          final socket = await req.response.detachSocket(writeHeaders: false);
          socket.destroy();
          await sub.cancel();
        }
      }, onDone: () {
        if (!done.isCompleted) done.complete();
      });
      return done.future;
    }

    await for (final chunk in req) {
      body.add(chunk);
    }
    final reject = rejectPut[sha];
    if (reject != null) throw _Err(_statusOf(reject), reject);
    final bytes = body.takeBytes();
    if (bytes.length > declared.size) throw _Err(413, 'too_large');
    if (crypto.sha256.convert(bytes).toString() != sha) throw _Err(422, 'hash_mismatch');
    stored.putIfAbsent(pkg, () => {})[sha] = bytes;
    req.response.statusCode = 204;
    await req.response.close();
  }

  Future<void> _commit(HttpRequest req, String pkg) async {
    await req.drain<void>();
    final manifest = _manifests[pkg];
    if (manifest == null) throw _Err(404, 'not_found');
    final m = Manifest.fromJson(jsonDecode(manifest) as Map<String, Object?>);
    final receipt = _receipts[pkg] ??
        (() {
          final have = stored[pkg] ?? {};
          if (m.files.any((f) => !have.containsKey(f.sha256) && !alreadyHave.contains(f.sha256))) {
            throw _Err(409, 'incomplete_package');
          }
          return _receipts[pkg] = {
            'schema_version': 1,
            'package_id': pkg,
            'received_at': DateTime.now().toUtc().toIso8601String(),
            'files': [
              for (final f in m.files) {...f.toJson(), 'status': 'stored'}
            ],
          };
        })();
    _json(req.response, 200, receipt);
  }

  static int _statusOf(String code) => const {
        'unsupported_type': 415,
        'too_large': 413,
        'hash_mismatch': 422,
      }[code]!;

  static Future<Map<String, Object?>> _readJson(HttpRequest req) async {
    final text = await utf8.decoder.bind(req).join();
    try {
      return jsonDecode(text) as Map<String, Object?>;
    } catch (_) {
      throw _Err(400, 'invalid_manifest');
    }
  }

  static Future<void> _json(HttpResponse res, int status, Object body) async {
    res
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(body));
    await res.close();
  }
}

class _Err implements Exception {
  final int status;
  final String code;
  _Err(this.status, this.code);
}

/// Proxy TCP que cuenta conexiones entrantes y las reenvía a `targetPort`.
class TcpCounter {
  final ServerSocket _socket;
  int connections = 0;

  TcpCounter._(this._socket, int targetPort) {
    _socket.listen((client) async {
      connections++;
      try {
        final upstream = await Socket.connect('127.0.0.1', targetPort);
        client.cast<List<int>>().pipe(upstream).catchError((_) {});
        upstream.cast<List<int>>().pipe(client).catchError((_) {});
      } catch (_) {
        client.destroy();
      }
    });
  }

  static Future<TcpCounter> start(int targetPort) async =>
      TcpCounter._(await ServerSocket.bind('127.0.0.1', 0), targetPort);

  int get port => _socket.port;

  Future<void> close() => _socket.close();
}
