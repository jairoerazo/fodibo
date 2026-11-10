import 'package:flutter/material.dart';

import '../transfer/contracts.dart';

/// Lista de archivos que el PC confirmó.
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
                  subtitle: Text('${f.size} bytes'),
                ),
            ],
          ),
        ),
        FilledButton(onPressed: onSendMore, child: const Text('Enviar más')),
      ],
    );
  }
}
