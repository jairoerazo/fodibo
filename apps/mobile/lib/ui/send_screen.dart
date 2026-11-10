import 'package:flutter/material.dart';

import '../transfer/contracts.dart';
import '../transfer/errors.dart';
import '../transfer/local_file.dart';
import 'receipt_view.dart';

typedef SendFn = Future<Receipt> Function(
  List<LocalFile> files, {
  String? packageId,
  void Function(String sha256, int sent, int total)? onProgress,
});

enum _Phase { idle, sending, done, rejected, lost }

/// Selección, envío y recibo (spec §7). Las dependencias de plataforma entran
/// por constructor para poder probarla sin red ni plugins.
class SendScreen extends StatefulWidget {
  final SendFn send;
  final Future<List<LocalFile>> Function() pickFiles;

  /// Se llama cuando el PC cerró la sesión; el llamador vuelve al escaneo.
  final VoidCallback onSessionClosed;

  const SendScreen({
    super.key,
    required this.send,
    required this.pickFiles,
    required this.onSessionClosed,
  });

  @override
  State<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends State<SendScreen> {
  var _files = <LocalFile>[];
  var _phase = _Phase.idle;
  final _progress = <String, double>{};
  String? _packageId;
  List<LocalFile> _lastSent = [];
  LocalFile? _rejected;
  Receipt? _receipt;

  bool _sendable(LocalFile f) => precheck(f).isEmpty;

  Future<void> _pick() async {
    final picked = await widget.pickFiles();
    if (!mounted) return;
    setState(() => _files = picked);
  }

  Future<void> _send(List<LocalFile> files, {required String packageId}) async {
    _packageId = packageId;
    _lastSent = files;
    setState(() {
      _phase = _Phase.sending;
      _progress.clear();
    });
    try {
      final receipt = await widget.send(files, packageId: packageId, onProgress: (sha, sent, total) {
        if (!mounted) return;
        setState(() => _progress[sha] = total == 0 ? 1 : sent / total);
      });
      if (!mounted) return;
      setState(() {
        _receipt = receipt;
        _phase = _Phase.done;
      });
    } on TransferException catch (e) {
      if (!mounted) return;
      if (e.code == 'session_closed' || e.code == 'unauthorized') {
        widget.onSessionClosed();
        return;
      }
      final culprit = const {'unsupported_type', 'too_large', 'hash_mismatch'}.contains(e.code) &&
              e.fileSha256 != null
          ? files.where((f) => f.sha256 == e.fileSha256).firstOrNull
          : null;
      setState(() {
        _rejected = culprit;
        _phase = culprit != null ? _Phase.rejected : _Phase.lost;
      });
    }
  }

  void _sendAll() => _send(_files.where(_sendable).toList(), packageId: newUuidV4());

  void _sendRest() {
    final rest = _lastSent.where((f) => f.sha256 != _rejected!.sha256).toList();
    if (rest.isEmpty) {
      setState(() {
        _files = [];
        _phase = _Phase.idle;
      });
      return;
    }
    _send(rest, packageId: newUuidV4());
  }

  void _reset() => setState(() {
        _files = [];
        _receipt = null;
        _phase = _Phase.idle;
      });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Conectado')),
      body: Padding(padding: const EdgeInsets.all(16), child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    switch (_phase) {
      case _Phase.done:
        return ReceiptView(receipt: _receipt!, onSendMore: _reset);
      case _Phase.rejected:
        return _message('El PC rechazó ${_rejected!.name}.', 'Enviar el resto', _sendRest);
      case _Phase.lost:
        return _message('Se perdió la conexión.', 'Reintentar',
            () => _send(_lastSent, packageId: _packageId!));
      case _Phase.idle:
      case _Phase.sending:
        return _fileList();
    }
  }

  Widget _message(String text, String action, VoidCallback onTap) => Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(text, textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton(onPressed: onTap, child: Text(action)),
        ],
      );

  Widget _fileList() {
    final sending = _phase == _Phase.sending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        OutlinedButton(onPressed: sending ? null : _pick, child: const Text('Elegir archivos')),
        const SizedBox(height: 8),
        Expanded(
          child: ListView(
            children: [
              for (final f in _files)
                ListTile(
                  leading: Icon(_sendable(f) ? Icons.insert_drive_file : Icons.warning_amber),
                  title: Text(f.name),
                  subtitle: _sendable(f)
                      ? (sending ? LinearProgressIndicator(value: _progress[f.sha256] ?? 0) : null)
                      : Text('No se enviará: ${_reason(precheck(f))}'),
                ),
            ],
          ),
        ),
        FilledButton(
          onPressed: sending || !_files.any(_sendable) ? null : _sendAll,
          child: const Text('Enviar'),
        ),
      ],
    );
  }

  String _reason(List<String> codes) => codes.contains('unsupported_type')
      ? 'tipo no admitido'
      : 'supera el límite de 50 MB';
}
