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

  test('precheckPackage: máximo 100 archivos y 500 MB por envío', () {
    LocalFile mk(int size) => LocalFile(
        path: '/x', name: 'x.png', mime: 'image/png', size: size, sha256: '0' * 64);
    expect(precheckPackage([]), isEmpty);
    expect(precheckPackage(List.generate(100, (_) => mk(1))), isEmpty);
    expect(precheckPackage(List.generate(101, (_) => mk(1))), ['too_many_files']);
    expect(precheckPackage(List.generate(10, (_) => mk(52428800))), isEmpty); // 500 MB justos
    expect(precheckPackage([...List.generate(10, (_) => mk(52428800)), mk(1)]),
        ['package_too_large']);
    expect(precheckPackage(List.generate(11, (_) => mk(49 * 1024 * 1024))), ['package_too_large']);
    expect(precheckPackage(List.generate(101, (_) => mk(52428800))),
        ['too_many_files', 'package_too_large']);
  });
}
