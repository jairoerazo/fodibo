import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/transfer/errors.dart';

const vectors = '../../packages/contracts/vectors';

List<File> files(String kind, String outcome) {
  final list = Directory('$vectors/$kind/$outcome')
      .listSync()
      .whereType<File>()
      .where((f) => f.path.endsWith('.json'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));
  if (list.isEmpty) throw StateError('sin vectores en $kind/$outcome');
  return list;
}

String name(File f) => f.uri.pathSegments.last;

Map<String, Object?> json(File f) =>
    jsonDecode(f.readAsStringSync()) as Map<String, Object?>;

void main() {
  group('QrPayload', () {
    for (final f in files('qr', 'valid')) {
      test('valid/${name(f)}', () {
        final qr = QrPayload.parse(f.readAsStringSync());
        expect(qr.hosts, isNotEmpty);
      });
    }
    for (final f in files('qr', 'invalid')) {
      test('invalid/${name(f)}', () {
        expect(
          () => QrPayload.parse(f.readAsStringSync()),
          throwsA(isA<TransferException>()
              .having((e) => e.code, 'code', 'invalid_qr')),
        );
      });
    }
    test('texto que no es JSON', () {
      expect(
        () => QrPayload.parse('no es json'),
        throwsA(isA<TransferException>()
            .having((e) => e.code, 'code', 'invalid_qr')),
      );
    });
    test('campos del QR válido', () {
      final qr = QrPayload.parse(
          File('$vectors/qr/valid/basic.json').readAsStringSync());
      expect(qr.hosts, ['192.168.1.20']);
      expect(qr.port, 49321);
      expect(qr.exp, DateTime.utc(2026, 11, 10, 21, 30));
    });
  });

  group('Receipt', () {
    for (final f in files('receipt', 'valid')) {
      test('valid/${name(f)}', () {
        final r = Receipt.fromJson(json(f));
        expect(r.files, isNotEmpty);
      });
    }
    for (final f in files('receipt', 'invalid')) {
      test('invalid/${name(f)}', () {
        expect(() => Receipt.fromJson(json(f)),
            throwsA(isA<FormatException>()));
      });
    }
  });

  group('Manifest', () {
    for (final f in files('manifest', 'valid')) {
      test('valid/${name(f)} (ida y vuelta)', () {
        final m = Manifest.fromJson(json(f));
        expect(m.toJson(), json(f));
      });
    }
    for (final f in files('manifest', 'invalid')) {
      test('invalid/${name(f)}', () {
        expect(() => Manifest.fromJson(json(f)),
            throwsA(isA<FormatException>()));
      });
    }
    test('toJson reproduce three-types.json', () {
      final src = json(File('$vectors/manifest/valid/three-types.json'));
      final files = (src['files'] as List).cast<Map<String, Object?>>();
      final m = Manifest(
        packageId: src['package_id'] as String,
        createdAt: src['created_at'] as String,
        deviceName: src['device_name'] as String,
        files: [
          for (final f in files)
            ManifestFile(
              fileId: f['file_id'] as String,
              name: f['name'] as String,
              mime: f['mime'] as String,
              size: f['size'] as int,
              sha256: f['sha256'] as String,
            ),
        ],
      );
      expect(m.toJson(), src);
    });
  });

  group('newUuidV4', () {
    test('1000 valores únicos con forma v4', () {
      final re = RegExp(
          r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
      final seen = <String>{};
      for (var i = 0; i < 1000; i++) {
        final u = newUuidV4();
        expect(re.hasMatch(u), isTrue, reason: u);
        seen.add(u);
      }
      expect(seen.length, 1000);
    });
  });
}
