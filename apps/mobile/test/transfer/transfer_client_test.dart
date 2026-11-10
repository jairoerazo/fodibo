import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/transfer/errors.dart';
import 'package:fodibo_transfer/transfer/local_file.dart';
import 'package:fodibo_transfer/transfer/pinned_client.dart';
import 'package:fodibo_transfer/transfer/transfer_client.dart';

import 'fake_server.dart';

Matcher throwsTransfer(String code, {String? fileSha256}) => throwsA(
      isA<TransferException>()
          .having((e) => e.code, 'code', code)
          .having((e) => e.fileSha256, 'fileSha256', fileSha256),
    );

void main() {
  late FakeServer server;
  late Directory dir;
  late List<Duration> sleeps;
  final clients = <TransferClient>[];

  Future<void> fakeSleep(Duration d) async => sleeps.add(d);

  Future<TransferClient> connect(QrPayload qr, {DateTime Function()? now}) async {
    final c = await TransferClient.connect(qr,
        deviceName: 'Pixel 8', now: now, sleep: fakeSleep);
    clients.add(c);
    return c;
  }

  Future<LocalFile> file(String name, int size, int seed) async {
    final bytes = Uint8List.fromList(List.generate(size, (i) => (i * 31 + seed) & 0xff));
    final f = File('${dir.path}/$name')..writeAsBytesSync(bytes);
    return LocalFile.fromPath(f.path);
  }

  Future<List<LocalFile>> threeFiles() async => [
        await file('a.jpg', 1000, 1),
        await file('b.pdf', 256 * 1024, 2),
        await file('c.json', 10, 3),
      ];

  setUp(() async {
    server = await FakeServer.start();
    dir = Directory.systemTemp.createTempSync('fodibo_tc');
    sleeps = [];
  });

  tearDown(() async {
    for (final c in clients) {
      c.close();
    }
    clients.clear();
    await server.close();
    dir.deleteSync(recursive: true);
  });

  test('createPinnedHttpClient: huella correcta acepta, otra rechaza', () async {
    final ok = createPinnedHttpClient(fingerprintOfPem('$fixtures/server.pem'));
    final bad = createPinnedHttpClient(fingerprintOfPem('$fixtures/other.pem'));
    addTearDown(() {
      ok.close(force: true);
      bad.close(force: true);
    });
    final uri = Uri.parse('https://127.0.0.1:${server.port}/v1/nada');
    final res = await (await ok.openUrl('GET', uri)).close();
    expect(res.statusCode, 401);
    await res.drain<void>();
    expect(ok.connectionTimeout, const Duration(seconds: 3));
    await expectLater(bad.openUrl('GET', uri).then((r) => r.close()),
        throwsA(isA<HandshakeException>()));
    expect(server.requests, 1);
  });

  test('huella correcta: envía 3 archivos y el recibo los lista', () async {
    final files = await threeFiles();
    final client = await connect(server.qr());
    final progress = <String, int>{};
    final receipt = await client.send(files,
        onProgress: (sha, sent, total) {
      expect(sent, lessThanOrEqualTo(total));
      progress[sha] = sent;
    });
    expect(receipt.files.map((f) => f.sha256), [for (final f in files) f.sha256]);
    expect(receipt.files.map((f) => f.name), ['a.jpg', 'b.pdf', 'c.json']);
    expect(server.stored[receipt.packageId]!.keys.toSet(),
        {for (final f in files) f.sha256});
    expect(progress, {for (final f in files) f.sha256: f.size});
    expect(sleeps, isEmpty);
  });

  test('huella de other.pem: fingerprint_mismatch, ninguna petición y no prueba más hosts',
      () async {
    final counter = await TcpCounter.start(server.port);
    addTearDown(counter.close);
    final qr = server.qr(fp: fingerprintOfPem('$fixtures/other.pem'));
    final viaCounter = QrPayload(
        hosts: ['127.0.0.1', '127.0.0.1'],
        port: counter.port,
        fp: qr.fp,
        secret: qr.secret,
        exp: qr.exp);
    await expectLater(connect(viaCounter), throwsTransfer('fingerprint_mismatch'));
    expect(server.requests, 0);
    expect(counter.connections, 1);
  });

  test('QR caducado: expired_qr sin abrir conexiones', () async {
    final counter = await TcpCounter.start(server.port);
    addTearDown(counter.close);
    final qr = server.qr();
    final viaCounter = QrPayload(
        hosts: qr.hosts, port: counter.port, fp: qr.fp, secret: qr.secret, exp: qr.exp);
    await expectLater(
        connect(viaCounter, now: () => qr.exp.add(const Duration(seconds: 1))),
        throwsTransfer('expired_qr'));
    expect(counter.connections, 0);
    expect(server.requests, 0);
  });

  test('primer host no enrutable, segundo 127.0.0.1: conecta con el segundo', () async {
    final client = await connect(server.qr(hosts: ['10.255.255.1', '127.0.0.1']));
    final receipt = await client.send([await file('a.jpg', 100, 1)]);
    expect(receipt.files, hasLength(1));
  });

  test('ningún host responde: unreachable', () async {
    final port = server.port;
    await server.close();
    final qr = QrPayload(
        hosts: ['127.0.0.1'],
        port: port,
        fp: fingerprintOfPem('$fixtures/server.pem'),
        secret: server.secret,
        exp: DateTime.now().toUtc().add(const Duration(minutes: 5)));
    await expectLater(connect(qr), throwsTransfer('unreachable'));
  });

  test('secreto incorrecto: invalid_secret', () async {
    final qr = server.qr();
    final wrong = QrPayload(
        hosts: qr.hosts, port: qr.port, fp: qr.fp, secret: 'B' * 22, exp: qr.exp);
    await expectLater(connect(wrong), throwsTransfer('invalid_secret'));
  });

  test('corte a mitad del 2.º archivo: reintenta, reanuncia y no resube el 1.º', () async {
    final files = await threeFiles();
    server.cutPutAfterBytes[files[1].sha256] = 64 * 1024;
    final client = await connect(server.qr());
    final receipt = await client.send(files);
    expect(receipt.files, hasLength(3));
    expect(server.announces, 2);
    expect(server.putCount, {
      files[0].sha256: 1,
      files[1].sha256: 2,
      files[2].sha256: 1,
    });
    expect(sleeps, [const Duration(seconds: 1)]);
  });

  test('5xx una vez en commit: reintenta tras 1 s y reanuncia', () async {
    final files = await threeFiles();
    server.fail500Once.add('commit');
    final client = await connect(server.qr());
    final receipt = await client.send(files);
    expect(receipt.files, hasLength(3));
    expect(server.announces, 2);
    expect(server.putCount.values, everyElement(1));
    expect(sleeps, [const Duration(seconds: 1)]);
  });

  test('reintentos agotados (el PC no responde): 4 esperas 1, 2, 4, 8 s y unreachable', () async {
    final files = await threeFiles();
    final proxy = await TcpCounter.start(server.port);
    addTearDown(proxy.close);
    final qr = server.qr();
    final client = await connect(QrPayload(
        hosts: qr.hosts, port: proxy.port, fp: qr.fp, secret: qr.secret, exp: qr.exp));
    proxy.dropAll();
    await expectLater(client.send(files), throwsTransfer('unreachable'));
    expect(sleeps, [for (final s in [1, 2, 4, 8]) Duration(seconds: s)]);
  });

  test('el PC detiene la sesión a mitad (puerto cerrado): session_closed tras reintentar', () async {
    final files = await threeFiles();
    final client = await connect(server.qr());
    expect((await client.send([files[0]])).files, hasLength(1));
    await server.close(); // «Detener», inactividad o QR regenerado: el PC deja de escuchar
    await expectLater(client.send(files), throwsTransfer('session_closed'));
    expect(sleeps, [for (final s in [1, 2, 4, 8]) Duration(seconds: s)]);
  });

  group('respuestas malformadas: invalid_response', () {
    final notUtf8 = [0xff, 0xfe, 0xfd];
    final cases = <String, List<int>>{
      'pair con lista JSON': '[1,2]'.codeUnits,
      'pair con bytes no UTF-8': notUtf8,
      'announce con lista JSON': '[1]'.codeUnits,
      'announce con texto no JSON': 'hola'.codeUnits,
      'announce con bytes no UTF-8': notUtf8,
      'commit con lista JSON': '[]'.codeUnits,
      'commit con bytes no UTF-8': notUtf8,
    };
    for (final MapEntry(key: name, value: raw) in cases.entries) {
      test(name, () async {
        final kind = name.split(' ').first;
        server.rawOk[kind] = raw;
        final files = [await file('a.jpg', 100, 1)];
        if (kind == 'pair') {
          await expectLater(connect(server.qr()), throwsTransfer('invalid_response'));
        } else {
          final client = await connect(server.qr());
          await expectLater(client.send(files), throwsTransfer('invalid_response'));
        }
      });
    }
  });

  test('solo sube los hashes de missing', () async {
    final files = await threeFiles();
    server.alreadyHave.addAll([files[0].sha256, files[2].sha256]);
    final client = await connect(server.qr());
    final progress = <String, int>{};
    await client.send(files, onProgress: (sha, sent, total) => progress[sha] = sent);
    expect(server.putCount, {files[1].sha256: 1});
    expect(progress, {for (final f in files) f.sha256: f.size});
  });

  test('unsupported_type: definitivo, con el archivo culpable', () async {
    final files = await threeFiles();
    server.rejectPut[files[1].sha256] = 'unsupported_type';
    final client = await connect(server.qr());
    await expectLater(client.send(files),
        throwsTransfer('unsupported_type', fileSha256: files[1].sha256));
    expect(server.putCount[files[1].sha256], 1);
    expect(sleeps, isEmpty);
  });

  test('too_large: definitivo, con el archivo culpable', () async {
    final files = await threeFiles();
    server.rejectPut[files[0].sha256] = 'too_large';
    final client = await connect(server.qr());
    await expectLater(
        client.send(files), throwsTransfer('too_large', fileSha256: files[0].sha256));
    expect(server.putCount[files[0].sha256], 1);
  });

  test('hash_mismatch dos veces: definitivo, con el archivo culpable', () async {
    final files = await threeFiles();
    server.rejectPut[files[2].sha256] = 'hash_mismatch';
    final client = await connect(server.qr());
    await expectLater(client.send(files),
        throwsTransfer('hash_mismatch', fileSha256: files[2].sha256));
    expect(server.putCount[files[2].sha256], 2);
    expect(sleeps, isEmpty);
  });

  test('401 a mitad de sesión: session_closed', () async {
    final client = await connect(server.qr());
    server.revokeSession();
    await expectLater(client.send(await threeFiles()), throwsTransfer('session_closed'));
  });

  test('send dos veces con el mismo packageId: mismo recibo, sin PUT la segunda', () async {
    final files = await threeFiles();
    final client = await connect(server.qr());
    final id = newUuidV4();
    final first = await client.send(files, packageId: id);
    final puts = Map.of(server.putCount);
    final second = await client.send(files, packageId: id);
    expect(second.packageId, id);
    expect(second.receivedAt, first.receivedAt);
    expect(second.files.map((f) => f.fileId), first.files.map((f) => f.fileId));
    expect(server.putCount, puts);
  });
}
