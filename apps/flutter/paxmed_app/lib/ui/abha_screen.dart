import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';

class AbhaScreen extends StatefulWidget {
  const AbhaScreen({super.key});

  @override
  State<AbhaScreen> createState() => _AbhaScreenState();
}

class _AbhaScreenState extends State<AbhaScreen> {
  Map<String, dynamic>? status;
  Map<String, dynamic>? link;
  String? txn;
  final _healthId = TextEditingController();
  final _otpCtrl = TextEditingController();
  String? msg;

  @override
  void dispose() {
    _healthId.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  Future<void> _refresh(ApiBinding binding) async {
    final c = binding.client;
    try {
      final s = await c.abhaStatus();
      Map<String, dynamic>? lnk;
      try {
        final raw = await c.abhaLinkGet();
        if (raw['linked'] == true || raw['linked']?.toString() == 'true') {
          lnk = Map<String, dynamic>.from(raw);
        }
      } catch (_) {
        /* not linked OK */
      }
      setState(() {
        status = s;
        link = lnk;
        msg = null;
      });
    } catch (e) {
      setState(() => msg = e.toString());
    }
  }

  @override
  void initState() {
    super.initState();
    unawaited(WidgetsBinding.instance.addPostFrameCallback((_) => _refresh(context.read<ApiBinding>())));
  }

  Future<void> _initiate(ApiBinding binding) async {
    try {
      final r =
          await binding.client.abhaAadhaarInitiate(healthId: _healthId.text.trim());
      setState(() {
        txn = r['txn_id']?.toString();
        msg = r['message']?.toString();
      });
      if (mounted && msg != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg!)));
      }
    } catch (e) {
      setState(() => msg = e.toString());
    }
  }

  Future<void> _complete(ApiBinding binding) async {
    if ((txn ?? '').trim().isEmpty || _otpCtrl.text.trim().isEmpty) return;
    try {
      final r =
          await binding.client.abhaAadhaarComplete(txnId: txn!, otp: _otpCtrl.text.trim());
      setState(() => msg = r['message']?.toString());
      await _refresh(binding);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('ABHA linking updated')));
    } catch (e) {
      setState(() => msg = e.toString());
    }
  }

  Future<void> _pull(ApiBinding binding) async {
    try {
      final r = await binding.client.abhaSyncFromAbha();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(r['message']?.toString() ?? 'Done')));
      await _refresh(binding);
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _push(ApiBinding binding) async {
    try {
      final r = await binding.client.abhaPushProfile();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${r['reason'] ?? r['skipped'] ?? r['message']}')));
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    final bind = context.watch<ApiBinding>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('ABHA'),
        actions: [IconButton(onPressed: () => _refresh(bind), icon: const Icon(Icons.refresh))],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (status != null)
            Card(
              child: ListTile(
                title: Text('Mode · ${status!['mode']}'),
                subtitle: Text('${status!['message']}'),
              ),
            ),
          const SizedBox(height: 12),
          if (link?['linked'] == true) ...[
            Card(
              child: ListTile(
                title: const Text('Linked'),
                subtitle: Text(() {
                  final inner = link!['link'];
                  if (inner is Map<String, dynamic>) {
                    return '${inner['health_id_masked'] ?? ''}'.trim().isEmpty
                        ? 'Linked (no masked id)'
                        : '${inner['health_id_masked']}';
                  }
                  return 'Linked';
                }()),
              ),
            ),
            ListTile(title: TextButton(onPressed: () => _pull(bind), child: const Text('Sync from ABHA'))),
            ListTile(title: TextButton(onPressed: () => _push(bind), child: const Text('Push profile to ABHA'))),
          ] else ...[
            const Text(
              'Link flow mirrors web Aadhaar stub: initiate after entering a normalized ABHA/PHR id, '
              'then enter OTP advertised by /api/abha/aadhaar/initiate.',
            ),
            TextField(controller: _healthId, decoration: const InputDecoration(labelText: 'ABHA / PHR identifier')),
            FilledButton(onPressed: () => _initiate(bind), child: const Text('Start Aadhaar OTP')),
            TextField(controller: _otpCtrl, decoration: const InputDecoration(labelText: 'OTP')),
            FilledButton.tonal(onPressed: () => _complete(bind), child: const Text('Complete link')),
          ],
          if (msg != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(msg!)),
        ],
      ),
    );
  }
}
