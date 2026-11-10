import 'dart:convert';
import 'dart:math';

import 'errors.dart';

/// Contratos v1 (espejo manual de packages/contracts/schemas/*.schema.json).
/// Las reglas replican a Ajv + ajv-formats para aceptar/rechazar los mismos
/// vectores.

const allowedMimes = <String>{
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/pdf',
  'application/json',
};

const maxFileBytes = 52428800;

// Equivalentes a los formatos de ajv-formats (modo "full").
final _ipv4 = RegExp(
    r'^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$');
final _uuid = RegExp(
    r'^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$',
    caseSensitive: false);
final _dateTime = RegExp(
    r'^(\d{4})-(\d\d)-(\d\d)[t ](\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:z|([+-])(\d\d)(?::?(\d\d))?)$',
    caseSensitive: false);
final _fp = RegExp(r'^sha256:[0-9a-f]{64}$');
final _secret = RegExp(r'^[A-Za-z0-9_-]{22}$');
final _sha = RegExp(r'^[0-9a-f]{64}$');

/// Interpreta un `date-time` RFC 3339 con zona obligatoria; null si no cumple.
DateTime? _parseDateTime(String s) {
  final m = _dateTime.firstMatch(s);
  if (m == null) return null;
  int g(int i) => int.parse(m[i]!);
  final year = g(1), month = g(2), day = g(3);
  final hour = g(4), minute = g(5), second = g(6);
  if (month < 1 || month > 12 || day < 1) return null;
  final leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (month == 2 && leap ? 29 : days[month - 1])) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  if (second == 60 && !(hour == 23 && minute == 59)) return null;
  var offset = Duration.zero;
  if (m[7] != null) {
    final oh = int.parse(m[8]!), om = m[9] == null ? 0 : int.parse(m[9]!);
    if (oh > 23 || om > 59) return null;
    final d = Duration(hours: oh, minutes: om);
    offset = m[7] == '-' ? -d : d;
  }
  return DateTime.utc(year, month, day, hour, minute, second > 59 ? 59 : second)
      .subtract(offset);
}

/// Entero JSON: Ajv acepta `1.0` como entero.
int? _asInt(Object? v) {
  if (v is int) return v;
  if (v is double && v.isFinite && v == v.truncateToDouble()) return v.toInt();
  return null;
}

class _Reader {
  final Map<String, Object?> json;
  final String where;
  _Reader(this.json, this.where, Set<String> required, Set<String> allowed) {
    for (final k in required) {
      if (!json.containsKey(k)) _fail('falta "$k"');
    }
    for (final k in json.keys) {
      if (!allowed.contains(k)) _fail('propiedad no permitida "$k"');
    }
  }

  Never _fail(String why) => throw FormatException('$where: $why');

  void constOne(String k) {
    if (_asInt(json[k]) != 1) _fail('"$k" debe ser 1');
  }

  String str(String k, {RegExp? pattern, int? minLen, int? maxLen}) {
    final v = json[k];
    if (v is! String) _fail('"$k" debe ser cadena');
    final len = v.runes.length; // JSON Schema cuenta puntos de código
    if (minLen != null && len < minLen) _fail('"$k" demasiado corto');
    if (maxLen != null && len > maxLen) _fail('"$k" demasiado largo');
    if (pattern != null && !pattern.hasMatch(v)) _fail('"$k" con formato inválido');
    return v;
  }

  String uuid(String k) => str(k, pattern: _uuid);

  String dateTime(String k) {
    final v = str(k);
    if (_parseDateTime(v) == null) _fail('"$k" no es date-time con zona');
    return v;
  }

  int integer(String k, int min, int max) {
    final v = _asInt(json[k]);
    if (v == null) _fail('"$k" debe ser entero');
    if (v < min || v > max) _fail('"$k" fuera de rango');
    return v;
  }

  String mime(String k) {
    final v = json[k];
    if (v is! String || !allowedMimes.contains(v)) _fail('"$k" no permitido');
    return v;
  }

  List<Map<String, Object?>> objects(String k, int min, int max) {
    final v = json[k];
    if (v is! List) _fail('"$k" debe ser lista');
    if (v.length < min || v.length > max) _fail('"$k" fuera de rango');
    return [
      for (final e in v)
        e is Map<String, Object?> ? e : _fail('"$k" contiene un no-objeto'),
    ];
  }
}

Map<String, Object?> _asMap(Object? v, String where) =>
    v is Map<String, Object?> ? v : throw FormatException('$where: no es objeto');

class QrPayload {
  final List<String> hosts;
  final int port;
  final String fp;
  final String secret;
  final DateTime exp;

  const QrPayload({
    required this.hosts,
    required this.port,
    required this.fp,
    required this.secret,
    required this.exp,
  });

  /// Lanza `TransferException('invalid_qr')` ante cualquier violación del esquema.
  static QrPayload parse(String text) {
    try {
      final r = _Reader(
        _asMap(jsonDecode(text), 'qr'),
        'qr',
        {'v', 'hosts', 'port', 'fp', 'secret', 'exp'},
        {'v', 'hosts', 'port', 'fp', 'secret', 'exp'},
      );
      r.constOne('v');
      final rawHosts = r.json['hosts'];
      if (rawHosts is! List || rawHosts.isEmpty) {
        throw const FormatException('qr: "hosts" vacío o no es lista');
      }
      final hosts = <String>[
        for (final h in rawHosts)
          h is String && _ipv4.hasMatch(h)
              ? h
              : throw const FormatException('qr: host no es IPv4'),
      ];
      return QrPayload(
        hosts: hosts,
        port: r.integer('port', 1, 65535),
        fp: r.str('fp', pattern: _fp),
        secret: r.str('secret', pattern: _secret),
        exp: _parseDateTime(r.dateTime('exp'))!,
      );
    } on FormatException catch (e) {
      throw TransferException('invalid_qr', e.message);
    }
  }
}

class ManifestFile {
  final String fileId;
  final String name;
  final String mime;
  final int size;
  final String sha256;

  const ManifestFile({
    required this.fileId,
    required this.name,
    required this.mime,
    required this.size,
    required this.sha256,
  });

  static const _keys = {'file_id', 'name', 'mime', 'size', 'sha256'};

  /// Lanza `FormatException` si no cumple el esquema.
  factory ManifestFile.fromJson(Map<String, Object?> json) {
    final r = _Reader(json, 'file', _keys, _keys);
    return ManifestFile(
      fileId: r.uuid('file_id'),
      name: r.str('name', minLen: 1, maxLen: 255),
      mime: r.mime('mime'),
      size: r.integer('size', 0, maxFileBytes),
      sha256: r.str('sha256', pattern: _sha),
    );
  }

  Map<String, Object?> toJson() => {
        'file_id': fileId,
        'name': name,
        'mime': mime,
        'size': size,
        'sha256': sha256,
      };
}

class Manifest {
  final String packageId;
  final String createdAt;
  final String deviceName;
  final List<ManifestFile> files;

  const Manifest({
    required this.packageId,
    required this.createdAt,
    required this.deviceName,
    required this.files,
  });

  static const _keys = {
    'schema_version',
    'package_id',
    'created_at',
    'device_name',
    'files'
  };

  /// Lanza `FormatException` si no cumple el esquema.
  factory Manifest.fromJson(Map<String, Object?> json) {
    final r = _Reader(json, 'manifest', _keys, _keys);
    r.constOne('schema_version');
    return Manifest(
      packageId: r.uuid('package_id'),
      createdAt: r.dateTime('created_at'),
      deviceName: r.str('device_name', minLen: 1, maxLen: 100),
      files: [for (final f in r.objects('files', 1, 100)) ManifestFile.fromJson(f)],
    );
  }

  Map<String, Object?> toJson() => {
        'schema_version': 1,
        'package_id': packageId,
        'created_at': createdAt,
        'device_name': deviceName,
        'files': [for (final f in files) f.toJson()],
      };
}

class ReceiptFile {
  final String fileId;
  final String name;
  final String mime;
  final int size;
  final String sha256;

  const ReceiptFile({
    required this.fileId,
    required this.name,
    required this.mime,
    required this.size,
    required this.sha256,
  });

  static const _keys = {'file_id', 'name', 'mime', 'size', 'sha256', 'status'};

  factory ReceiptFile.fromJson(Map<String, Object?> json) {
    final r = _Reader(json, 'receipt file', _keys, _keys);
    if (json['status'] != 'stored') {
      throw const FormatException('receipt file: "status" debe ser "stored"');
    }
    return ReceiptFile(
      fileId: r.uuid('file_id'),
      name: r.str('name', minLen: 1, maxLen: 255),
      mime: r.mime('mime'),
      size: r.integer('size', 0, maxFileBytes),
      sha256: r.str('sha256', pattern: _sha),
    );
  }
}

class Receipt {
  final String packageId;
  final String receivedAt;
  final List<ReceiptFile> files;

  const Receipt({
    required this.packageId,
    required this.receivedAt,
    required this.files,
  });

  static const _keys = {'schema_version', 'package_id', 'received_at', 'files'};

  /// Lanza `FormatException` si no cumple el esquema.
  factory Receipt.fromJson(Map<String, Object?> json) {
    final r = _Reader(json, 'receipt', _keys, _keys);
    r.constOne('schema_version');
    return Receipt(
      packageId: r.uuid('package_id'),
      receivedAt: r.dateTime('received_at'),
      files: [for (final f in r.objects('files', 1, 100)) ReceiptFile.fromJson(f)],
    );
  }
}

/// UUID v4 en minúsculas generado con `Random.secure()`.
String newUuidV4() {
  final rnd = Random.secure();
  final b = List<int>.generate(16, (_) => rnd.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
      '${h.substring(16, 20)}-${h.substring(20)}';
}
