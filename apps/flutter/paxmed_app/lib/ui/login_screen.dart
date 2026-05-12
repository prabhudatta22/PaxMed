import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _otp = TextEditingController();
  String? _err;
  bool _busy = false;
  bool _otpSent = false;

  @override
  void dispose() {
    _phone.dispose();
    _otp.dispose();
    super.dispose();
  }

  String _compactPhone() => _phone.text.replaceAll(RegExp(r'\D'), '');

  Future<void> _request() async {
    final api = context.read<ApiBinding>();

    final compact = _compactPhone();
    if (compact.length < 10) {
      setState(() => _err = 'Enter a valid Indian mobile number');
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final r = await api.client.postAuthRequestOtp(compact);
      final dev = r['dev_otp'];
      _otpSent = true;
      if (mounted && dev != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Dev OTP: $dev')));
      }
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final api = context.read<ApiBinding>();
    final auth = context.read<AuthState>();
    final compact = _compactPhone();

    final code = _otp.text.trim();
    if (compact.length < 10 || code.isEmpty) {
      setState(() => _err = 'Enter phone + OTP.');
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final r = await api.client.postAuthVerifyOtp(phoneDigits: compact, code: code);
      final u = r['user'];
      if (u is Map<String, dynamic>) {
        auth.setUser(u);
      }
      await auth.refresh(api);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: AbsorbPointer(
          absorbing: _busy,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Use the same OTP login flow as the PaxMed web app. ',
                style: TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[\d+ ]'))],
                decoration: const InputDecoration(
                  labelText: 'Phone number',
                  hintText: '+91xxxxxxxxxx',
                ),
              ),
              const SizedBox(height: 10),
              FilledButton(onPressed: _busy ? null : _request, child: const Text('Send OTP')),
              const SizedBox(height: 16),
              TextField(
                controller: _otp,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'OTP', hintText: '6-digit (or dummy 12345)'),
              ),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: _busy ? null : _verify,
                child: Text(_otpSent ? 'Verify & continue' : 'Verify'),
              ),
              if (_err != null) ...[
                const SizedBox(height: 12),
                Text(_err!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              if (_busy) const Padding(padding: EdgeInsets.only(top: 16), child: LinearProgressIndicator()),
              const Spacer(),
              Text(
                'Dummy phone enabled on servers: +919100946364 with OTP 12345.',
                style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
