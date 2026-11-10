@Tags(['interop'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/transfer/errors.dart';
import 'package:fodibo_transfer/transfer/local_file.dart';
import 'package:fodibo_transfer/transfer/transfer_client.dart';

/// Interoperabilidad con el servidor Node real: valida la fijación de huella
/// entre `selfsigned`/Node y `dart:io`, y el protocolo de extremo a extremo.
void main() {
  final repoRoot = Directory.current.parent.parent.path;
  Process? server;
  late Directory dataDir;
  late Directory filesDir;
  final stderrLog = StringBuffer();
  late Future<String> qrLine;

  setUpAll(() async {
    dataDir = Directory.systemTemp.createTempSync('fodibo_interop_data');
    filesDir = Directory.systemTemp.createTempSync('fodibo_interop_files');
    final proc = server = await Process.start(
      'npm',
      ['run', 'dev:server', '-w', '@fodibo/desktop'],
      workingDirectory: repoRoot,
      environment: {'FODIBO_HOSTS': '127.0.0.1', 'FODIBO_DATA_DIR': dataDir.path},
    );
    proc.stderr.transform(utf8.decoder).listen(stderrLog.write);
    final qr = Completer<String>();
    proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.startsWith('QR:') && !qr.isCompleted) qr.complete(line.substring(3));
    });
    unawaited(proc.exitCode.then((code) {
      if (!qr.isCompleted) qr.completeError(StateError('dev-server terminó ($code): $stderrLog'));
    }));
    qrLine = qr.future.timeout(const Duration(seconds: 30),
        onTimeout: () => throw TimeoutException('dev-server no imprimió QR: en 30 s; stderr: $stderrLog'));
    // Evita un error no capturado si setUpAll falla antes de que el test lo espere.
    qrLine.ignore();
  });

  tearDownAll(() async {
    final proc = server;
    if (proc != null) {
      proc.kill(ProcessSignal.sigint);
      await proc.exitCode.timeout(const Duration(seconds: 5), onTimeout: () {
        proc.kill(ProcessSignal.sigkill);
        return proc.exitCode;
      });
    }
    dataDir.deleteSync(recursive: true);
    filesDir.deleteSync(recursive: true);
  });

  Future<LocalFile> write(String name, List<int> bytes) async {
    final f = File('${filesDir.path}/$name')..writeAsBytesSync(bytes);
    return LocalFile.fromPath(f.path);
  }

  test('huella distinta: fingerprint_mismatch contra el servidor Node', () async {
    final qr = QrPayload.parse(await qrLine);
    final wrongFp = QrPayload(
        hosts: qr.hosts,
        port: qr.port,
        fp: 'sha256:${'0' * 64}',
        secret: qr.secret,
        exp: qr.exp);
    await expectLater(
        TransferClient.connect(wrongFp, deviceName: 'Prueba interop'),
        throwsA(isA<TransferException>()
            .having((e) => e.code, 'code', 'fingerprint_mismatch')));
  });

  // Va después: el secreto es de un solo uso, y el rechazo anterior no lo gasta.
  test('envía JPEG, PDF y JSON al servidor Node con huella fijada', () async {
    final qr = QrPayload.parse(await qrLine);
    expect(qr.hosts, ['127.0.0.1']);
    final files = [
      await write('foto.jpg', [0xff, 0xd8, 0xff, 0xe0, ...List.filled(4096, 7)]),
      await write('doc.pdf', [...ascii.encode('%PDF-1.4\n'), ...List.filled(70000, 1)]),
      await write('datos.json', utf8.encode('{"á":"ñ","n":[1,2,3]}')),
    ];
    final client = await TransferClient.connect(qr, deviceName: 'Prueba interop');
    addTearDown(client.close);
    final receipt = await client.send(files);
    expect(receipt.files.map((f) => (f.name, f.mime, f.size, f.sha256)), [
      for (final f in files) (f.name, f.mime, f.size, f.sha256),
    ]);
    final stored = Directory('${dataDir.path}/inbox/${receipt.packageId}/files')
        .listSync()
        .map((e) => e.uri.pathSegments.last)
        .toSet();
    expect(stored, {for (final f in files) f.sha256});

    // Repetir con el mismo package_id devuelve el mismo recibo.
    final again = await client.send(files, packageId: receipt.packageId);
    expect(again.receivedAt, receipt.receivedAt);
  });
}
