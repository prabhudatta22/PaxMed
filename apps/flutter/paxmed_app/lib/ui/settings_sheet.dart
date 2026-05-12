import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/settings_state.dart';

class SettingsSheet extends StatefulWidget {
  const SettingsSheet({super.key});

  @override
  State<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<SettingsSheet> {
  final _ctrl = TextEditingController();

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<SettingsState>();
    _ctrl.text = settings.baseUrl;

    return Padding(
      padding: EdgeInsets.only(
        left: 16,
        right: 16,
        top: 12,
        bottom: 16 + MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text('Settings', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
              ),
              IconButton(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const Text('API base URL', style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          TextField(
            controller: _ctrl,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(
              hintText: 'http://10.0.2.2:3000',
            ),
          ),
          const SizedBox(height: 10),
          const Text(
            'Android emulator uses http://10.0.2.2:3000 for localhost. iOS simulator can use http://localhost:3000. '
            'On a physical device, use your laptop LAN IP (e.g. http://192.168.1.10:3000).',
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: () async {
                    await settings.setBaseUrl(_ctrl.text);
                    if (context.mounted) Navigator.of(context).pop();
                  },
                  child: const Text('Save'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

