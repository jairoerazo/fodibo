import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/transfer/contracts.dart';
import 'package:fodibo_transfer/ui/receipt_view.dart';

void main() {
  test('formatSize: como en la tarjeta del PC', () {
    expect(formatSize(512), '512 B');
    expect(formatSize(1536), '1,5 KB');
    expect(formatSize(2481930), '2,4 MB');
  });

  testWidgets('el recibo muestra nombre, tipo, tamaño e integridad de cada archivo', (tester) async {
    const receipt = Receipt(
      packageId: '00000000-0000-4000-8000-000000000000',
      receivedAt: '2026-11-10T21:26:14Z',
      files: [
        ReceiptFile(fileId: 'f1', name: 'recibo.jpg', mime: 'image/jpeg', size: 2481930, sha256: 'a'),
        ReceiptFile(fileId: 'f2', name: 'datos.json', mime: 'application/json', size: 7, sha256: 'b'),
      ],
    );
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: ReceiptView(receipt: receipt, onSendMore: () {})),
    ));
    expect(find.text('recibo.jpg'), findsOneWidget);
    expect(find.textContaining('image/jpeg · 2,4 MB'), findsOneWidget);
    expect(find.textContaining('application/json · 7 B'), findsOneWidget);
    expect(find.textContaining('✓ Integridad verificada'), findsNWidgets(2));
  });
}
