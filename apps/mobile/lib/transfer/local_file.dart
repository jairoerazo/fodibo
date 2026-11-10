import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;

import 'contracts.dart';

/// Tipo MIME por extensión (sin distinguir mayúsculas); null si no se admite.
String? mimeForName(String name) {
  final dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  switch (name.substring(dot + 1).toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
  }
  return null;
}

class LocalFile {
  final String path;
  final String name;
  final String mime;
  final int size;
  final String sha256;

  const LocalFile({
    required this.path,
    required this.name,
    required this.mime,
    required this.size,
    required this.sha256,
  });

  /// Lee tamaño y SHA-256 (en streaming). Si el tipo no se reconoce por el
  /// nombre, `mime` es `application/octet-stream` y `precheck` lo rechaza.
  static Future<LocalFile> fromPath(String path, {String? name}) async {
    final file = File(path);
    final fileName = name ?? path.split(Platform.pathSeparator).last;
    final size = await file.length();
    final digest = await crypto.sha256.bind(file.openRead()).first;
    return LocalFile(
      path: path,
      name: fileName,
      mime: mimeForName(fileName) ?? 'application/octet-stream',
      size: size,
      sha256: digest.toString(),
    );
  }
}

/// Códigos de error previsibles antes de subir: `unsupported_type`, `too_large`.
List<String> precheck(LocalFile f) => [
      if (!allowedMimes.contains(f.mime)) 'unsupported_type',
      if (f.size > maxFileBytes) 'too_large',
    ];
