import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/transfer/errors.dart';
import 'package:fodibo_transfer/transfer/local_file.dart';
import 'package:fodibo_transfer/ui/send_screen.dart';

LocalFile lf(String name, String mime, String sha) =>
    LocalFile(path: '/x/$name', name: name, mime: mime, size: 10, sha256: sha);

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
}) async {
  final calls = <Call>[];
  await tester.pumpWidget(MaterialApp(
    home: SendScreen(
      pickFiles: () async => [a, b, gif],
      onSessionClosed: onSessionClosed ?? () {},
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
}
