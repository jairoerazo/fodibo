import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/local_file.dart';

void main() {
  test('fromPath calcula tamaño y SHA-256', () async {
    final dir = Directory.systemTemp.createTempSync('fodibo_lf');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/datos.json')..writeAsStringSync('{"a":1}');
    final lf = await LocalFile.fromPath(f.path);
    expect(lf.size, 7);
    expect(lf.sha256,
        '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
    expect(lf.name, 'datos.json');
    expect(lf.mime, 'application/json');
  });

  test('fromPath admite nombre explícito', () async {
    final dir = Directory.systemTemp.createTempSync('fodibo_lf');
    addTearDown(() => dir.deleteSync(recursive: true));
    final f = File('${dir.path}/x.bin')..writeAsStringSync('x');
    final lf = await LocalFile.fromPath(f.path, name: 'foto.PNG');
    expect(lf.name, 'foto.PNG');
    expect(lf.mime, 'image/png');
  });

  test('mimeForName', () {
    expect(mimeForName('FOTO.JPG'), 'image/jpeg');
    expect(mimeForName('a.jpeg'), 'image/jpeg');
    expect(mimeForName('a.heif'), 'image/heic');
    expect(mimeForName('a.pdf'), 'application/pdf');
    expect(mimeForName('x.gif'), isNull);
    expect(mimeForName('sinextension'), isNull);
  });

  test('precheck', () {
    LocalFile mk(String mime, int size) => LocalFile(
        path: '/x', name: 'x', mime: mime, size: size, sha256: '0' * 64);
    expect(precheck(mk('image/png', 52428800)), isEmpty);
    expect(precheck(mk('image/png', 52428801)), ['too_large']);
    expect(precheck(mk('application/octet-stream', 1)), ['unsupported_type']);
    expect(precheck(mk('application/octet-stream', 52428801)), ['unsupported_type', 'too_large']);
  });
}
