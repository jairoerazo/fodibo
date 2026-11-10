import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/transfer/errors.dart';
import 'package:fodibo_transfer/transfer/local_file.dart';
import 'package:fodibo_transfer/ui/send_screen.dart';

LocalFile lf(String name, String mime, String sha, {int size = 10}) =>
    LocalFile(path: '/x/$name', name: name, mime: mime, size: size, sha256: sha);

final a = lf('a.jpg', 'image/jpeg', 'a' * 64);
final b = lf('b.pdf', 'application/pdf', 'b' * 64);
final gif = lf('c.gif', 'application/octet-stream', 'c' * 64);

Receipt receiptFor(String id, List<LocalFile> fs) => Receipt(
      packageId: id,
      receivedAt: '2026-11-10T10:00:00Z',
      files: [
        for (final f in fs)
          ReceiptFile(
              fileId: 'id-${f.name}', name: f.name, mime: f.mime, size: f.size, sha256: f.sha256),
      ],
    );

class Call {
  final List<LocalFile> files;
  final String? packageId;
  Call(this.files, this.packageId);
}

Future<List<Call>> pumpScreen(
  WidgetTester tester,
  Future<Receipt> Function(List<LocalFile>, String id, int n) behavior, {
  void Function()? onSessionClosed,
  void Function()? onRescan,
  Future<List<LocalFile>> Function()? pickFiles,
}) async {
  final calls = <Call>[];
  await tester.pumpWidget(MaterialApp(
    home: SendScreen(
      pickFiles: pickFiles ?? () async => [a, b, gif],
      onSessionClosed: onSessionClosed ?? () {},
      onRescan: onRescan ?? () {},
      send: (files, {packageId, onProgress}) {
        calls.add(Call(files, packageId));
        return behavior(files, packageId!, calls.length);
      },
    ),
  ));
  await tester.tap(find.text('Elegir archivos'));
  await tester.pumpAndSettle();
  return calls;
}

void main() {
  testWidgets('el archivo no admitido se marca y no se envía', (tester) async {
    final calls = await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs));
    expect(find.text('Conectado'), findsOneWidget);
    expect(find.textContaining('c.gif'), findsOneWidget);
    expect(find.textContaining('No se enviará'), findsOneWidget);
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(calls, hasLength(1));
    expect(calls.single.files.map((f) => f.name), ['a.jpg', 'b.pdf']);
    expect(find.text('Enviar más'), findsOneWidget);
    expect(find.textContaining('b.pdf'), findsOneWidget);
  });

  testWidgets('rechazo de un archivo: «Enviar el resto» con otro packageId', (tester) async {
    final calls = await pumpScreen(tester, (fs, id, n) async {
      if (n == 1) throw TransferException('unsupported_type', '', b.sha256);
      return receiptFor(id, fs);
    });
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(find.text('El PC rechazó b.pdf.'), findsOneWidget);
    await tester.tap(find.text('Enviar el resto'));
    await tester.pumpAndSettle();
    expect(calls, hasLength(2));
    expect(calls[1].files.map((f) => f.name), ['a.jpg']);
    expect(calls[1].packageId, isNot(calls[0].packageId));
    expect(find.text('Enviar más'), findsOneWidget);
  });

  testWidgets('conexión perdida: «Reintentar» usa el mismo packageId', (tester) async {
    final calls = await pumpScreen(tester, (fs, id, n) async {
      if (n == 1) throw const TransferException('unreachable');
      return receiptFor(id, fs);
    });
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(find.text('No se encontró el PC. Comprueba que ambos están en la misma red Wi-Fi.'), findsNothing);
    expect(find.text('Se perdió la conexión.'), findsOneWidget);
    await tester.tap(find.text('Reintentar'));
    await tester.pumpAndSettle();
    expect(calls, hasLength(2));
    expect(calls[1].packageId, calls[0].packageId);
    expect(calls[1].files.map((f) => f.name), ['a.jpg', 'b.pdf']);
  });

  testWidgets('session_closed vuelve al escaneo', (tester) async {
    var closed = 0;
    await pumpScreen(tester, (fs, id, n) async => throw const TransferException('session_closed'),
        onSessionClosed: () => closed++);
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(closed, 1);
  });

  testWidgets('código desconocido se trata como conexión perdida', (tester) async {
    await pumpScreen(tester, (fs, id, n) async => throw const TransferException('internal'));
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(find.text('Se perdió la conexión.'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);
  });

  FilledButton sendButton(WidgetTester tester) =>
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Enviar'));

  testWidgets('más de 100 archivos: aviso y «Enviar» desactivado', (tester) async {
    final many = [
      for (var i = 0; i < 101; i++) lf('f$i.jpg', 'image/jpeg', i.toRadixString(16).padLeft(64, '0'))
    ];
    final calls = await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs),
        pickFiles: () async => many);
    expect(find.text('Demasiados archivos: máximo 100 por envío.'), findsOneWidget);
    expect(sendButton(tester).onPressed, isNull);
    expect(calls, isEmpty);
  });

  testWidgets('más de 500 MB en total: aviso y «Enviar» desactivado', (tester) async {
    final big = [
      for (var i = 0; i < 11; i++)
        lf('f$i.pdf', 'application/pdf', i.toRadixString(16).padLeft(64, '0'), size: 49 * 1024 * 1024)
    ];
    await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs), pickFiles: () async => big);
    expect(find.text('El envío supera 500 MB. Quita algunos archivos.'), findsOneWidget);
    expect(sendButton(tester).onPressed, isNull);
  });

  testWidgets('los archivos que no se enviarán no cuentan para el límite del envío', (tester) async {
    final huge = lf('x.gif', 'application/octet-stream', 'd' * 64, size: 600 * 1024 * 1024);
    await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs), pickFiles: () async => [a, huge]);
    expect(find.textContaining('500 MB'), findsNothing);
    expect(sendButton(tester).onPressed, isNotNull);
  });

  for (final code in [
    'invalid_manifest',
    'too_large',
    'package_conflict',
    'incomplete_package',
    'not_found',
    'http_400',
  ]) {
    testWidgets('$code sin archivo culpable: «El PC rechazó el envío.» y «Volver»', (tester) async {
      final calls = await pumpScreen(tester, (fs, id, n) async => throw TransferException(code));
      await tester.tap(find.text('Enviar'));
      await tester.pumpAndSettle();
      expect(find.text('El PC rechazó el envío.'), findsOneWidget);
      expect(find.text('Reintentar'), findsNothing);
      expect(find.text('Se perdió la conexión.'), findsNothing);
      await tester.tap(find.text('Volver'));
      await tester.pumpAndSettle();
      expect(find.text('Elegir archivos'), findsOneWidget);
      expect(find.text('a.jpg'), findsOneWidget); // conserva la selección
      expect(sendButton(tester).onPressed, isNotNull);
      expect(calls, hasLength(1));
    });
  }

  testWidgets('conexión perdida: «Escanear de nuevo» vuelve al escaneo', (tester) async {
    var rescans = 0;
    var closed = 0;
    await pumpScreen(tester, (fs, id, n) async => throw const TransferException('unreachable'),
        onRescan: () => rescans++, onSessionClosed: () => closed++);
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(find.text('Reintentar'), findsOneWidget);
    await tester.tap(find.text('Escanear de nuevo'));
    await tester.pumpAndSettle();
    expect(rescans, 1);
    expect(closed, 0);
  });

  testWidgets('error inesperado al enviar: conexión perdida, no se queda enviando', (tester) async {
    await pumpScreen(tester, (fs, id, n) async => throw const FormatException('basura'));
    await tester.tap(find.text('Enviar'));
    await tester.pumpAndSettle();
    expect(find.text('Se perdió la conexión.'), findsOneWidget);
    expect(find.text('Reintentar'), findsOneWidget);
  });

  testWidgets('selector cancelado: conserva la selección actual', (tester) async {
    var picks = 0;
    await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs),
        pickFiles: () async => ++picks == 1 ? [a, b] : <LocalFile>[]);
    await tester.tap(find.text('Elegir archivos'));
    await tester.pumpAndSettle();
    expect(picks, 2);
    expect(find.text('a.jpg'), findsOneWidget);
    expect(find.text('b.pdf'), findsOneWidget);
  });

  testWidgets('error al leer archivos: conserva la selección y avisa', (tester) async {
    var picks = 0;
    await pumpScreen(tester, (fs, id, n) async => receiptFor(id, fs), pickFiles: () async {
      if (++picks == 1) return [a, b];
      throw const FileSystemException('sin permiso');
    });
    await tester.tap(find.text('Elegir archivos'));
    await tester.pumpAndSettle();
    expect(find.text('No se pudieron leer los archivos.'), findsOneWidget);
    expect(find.text('a.jpg'), findsOneWidget);
    expect(find.text('b.pdf'), findsOneWidget);
  });
}
