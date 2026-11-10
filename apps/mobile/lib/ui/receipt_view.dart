import 'package:flutter/material.dart';

import '../transfer/contracts.dart';

/// Tamaño legible con coma decimal, igual que la tarjeta del PC:
/// 2 481 930 bytes → «2,4 MB».
String formatSize(int bytes) {
  String one(double n) => n.toStringAsFixed(1).replaceAll('.', ',');
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${one(bytes / 1024)} KB';
  return '${one(bytes / (1024 * 1024))} MB';
}

/// Lista de archivos que el PC confirmó: el mismo recibo que la tarjeta del PC
/// (nombre, tipo, tamaño e integridad verificada; spec §2).
class ReceiptView extends StatelessWidget {
  final Receipt receipt;
  final VoidCallback onSendMore;

  const ReceiptView({super.key, required this.receipt, required this.onSendMore});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Recibido en el PC', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Expanded(
          child: ListView(
            children: [
              for (final f in receipt.files)
                ListTile(
                  leading: const Icon(Icons.check_circle),
                  title: Text(f.name),
                  subtitle: Text('${f.mime} · ${formatSize(f.size)}\n✓ Integridad verificada'),
                  isThreeLine: true,
                ),
            ],
          ),
        ),
        FilledButton(onPressed: onSendMore, child: const Text('Enviar más')),
      ],
    );
  }
}
