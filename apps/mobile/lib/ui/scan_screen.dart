import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Escáner de QR. Entrega el texto leído una sola vez; la lógica de conexión
/// vive en el llamador.
class ScanScreen extends StatefulWidget {
  final void Function(String text) onScanned;

  const ScanScreen({super.key, required this.onScanned});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  var _handled = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Escanear código del PC')),
      body: MobileScanner(
        onDetect: (capture) {
          if (_handled) return;
          final text = capture.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
          if (text == null) return;
          _handled = true;
          widget.onScanned(text);
        },
      ),
    );
  }
}
