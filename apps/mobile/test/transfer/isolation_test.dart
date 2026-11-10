import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Criterio 6: `lib/transfer/` no depende de Flutter (espejo de
/// `core-isolation.test.ts` en el escritorio).
void main() {
  test('lib/transfer no importa package:flutter', () {
    final files = Directory('lib/transfer')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList();
    expect(files.length, greaterThanOrEqualTo(5));
    final flutterImport = RegExp(r'''^\s*(import|export)\s+['"]package:flutter(_test)?/''',
        multiLine: true);
    final offenders = [
      for (final f in files)
        if (flutterImport.hasMatch(f.readAsStringSync())) f.path,
    ];
    expect(offenders, isEmpty);
  });
}
