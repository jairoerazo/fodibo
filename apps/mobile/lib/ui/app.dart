import 'package:device_info_plus/device_info_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../transfer/contracts.dart';
import '../transfer/errors.dart';
import '../transfer/local_file.dart';
import '../transfer/transfer_client.dart';
import 'scan_screen.dart';
import 'send_screen.dart';

/// Mensaje de usuario para un error de escaneo/conexión.
String scanErrorMessage(TransferException e) {
  switch (e.code) {
    case 'expired_qr':
    case 'invalid_secret':
      return 'El código caducó o ya se usó. Genera uno nuevo en el PC.';
    case 'fingerprint_mismatch':
      return 'El PC no es el esperado. No se envió nada.';
    case 'invalid_qr':
      return 'El código no es de FODIBO. Escanea el código que muestra el PC.';
    case 'unreachable':
      return 'No se encontró el PC. Comprueba que ambos están en la misma red Wi-Fi.';
    default:
      return 'Se perdió la conexión.';
  }
}

class FodiboApp extends StatelessWidget {
  const FodiboApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'FODIBO',
        theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
        home: const _Home(),
      );
}

class _Home extends StatefulWidget {
  const _Home();

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  String? _notice;
  var _busy = false;

  Future<void> _scan() async {
    setState(() => _notice = null);
    final text = await Navigator.of(context).push<String>(MaterialPageRoute(
      builder: (c) => ScanScreen(onScanned: (t) => Navigator.of(c).pop(t)),
    ));
    if (text == null || !mounted) return;
    setState(() => _busy = true);
    TransferClient? client;
    try {
      final qr = QrPayload.parse(text);
      final android = await DeviceInfoPlugin().androidInfo;
      client = await TransferClient.connect(qr, deviceName: android.model);
    } on TransferException catch (e) {
      if (mounted) setState(() => _notice = scanErrorMessage(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (client == null || !mounted) return;
    final connected = client;
    final closed = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (c) => SendScreen(
        send: connected.send,
        pickFiles: _pickFiles,
        onSessionClosed: () => Navigator.of(c).pop(true),
      ),
    ));
    connected.close();
    if (closed == true && mounted) setState(() => _notice = 'La sesión en el PC terminó.');
  }

  Future<List<LocalFile>> _pickFiles() async {
    final picked = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['jpg', 'jpeg', 'png', 'heic', 'heif', 'pdf', 'json'],
    );
    return [
      for (final p in picked)
        if (p.path != null) await LocalFile.fromPath(p.path!, name: p.name),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('FODIBO')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_notice != null) ...[
                Text(_notice!, textAlign: TextAlign.center),
                const SizedBox(height: 16),
              ],
              if (_busy)
                const CircularProgressIndicator()
              else
                FilledButton(onPressed: _scan, child: const Text('Escanear código del PC')),
            ],
          ),
        ),
      ),
    );
  }
}
