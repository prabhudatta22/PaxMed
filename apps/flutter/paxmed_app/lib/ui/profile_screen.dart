import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';
import 'abha_screen.dart';
import 'login_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Map<String, dynamic>? profile;
  List<Map<String, dynamic>> addresses = [];
  List<Map<String, dynamic>> payments = [];
  List<Map<String, dynamic>> rxList = [];

  final _fullName = TextEditingController();
  final _email = TextEditingController();
  final _dob = TextEditingController(); // yyyy-mm-dd
  String _gender = 'prefer_not_to_say';

  String? err;
  bool loading = false;

  @override
  void dispose() {
    _fullName.dispose();
    _email.dispose();
    _dob.dispose();
    super.dispose();
  }

  Future<void> load() async {
    if (!context.read<AuthState>().isLoggedIn) {
      return;
    }

    final api = context.read<ApiBinding>().client;
    setState(() {
      loading = true;
      err = null;
    });
    try {
      final b = await api.getProfileBundle();
      final pr = await api.listPrescriptions();

      profile = {};
      final prRaw = b['profile'];
      if (prRaw is Map<String, dynamic>) {
        profile = Map<String, dynamic>.from(prRaw);
      }

      addresses = [];
      final adRaw = b['addresses'];
      if (adRaw is List) {
        addresses = adRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      }

      payments = [];
      final payRaw = b['payment_methods'];
      if (payRaw is List) {
        payments = payRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      }

      rxList = [];
      final presc = pr['prescriptions'];
      if (presc is List) {
        rxList = presc.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      }

      _fullName.text = '${profile?['full_name'] ?? ''}';
      _email.text = '${profile?['email'] ?? ''}';
      final dob = '${profile?['date_of_birth'] ?? ''}';
      if (dob.trim().isNotEmpty && dob != 'null') _dob.text = dob;
      final g = '${profile?['gender'] ?? ''}'.trim();
      if (g.isNotEmpty &&
          ['male', 'female', 'other', 'prefer_not_to_say'].contains(g)) {
        _gender = g;
      }
    } catch (e) {
      err = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  @override
  void initState() {
    super.initState();
    unawaited(WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      if (!context.read<AuthState>().isLoggedIn) return;
      await load();
    }));
  }

  Future<void> _saveBasic(ApiBinding binding) async {
    try {
      await binding.client.putProfileBasic({
        'full_name': _fullName.text.trim(),
        'email': _email.text.trim(),
        if (_dob.text.trim().isNotEmpty) 'date_of_birth': _dob.text.trim(),
        'gender': _gender,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Saved profile')));
      await load();
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _uploadRx(ApiBinding binding) async {
    final pick = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 88);
    if (pick == null) return;
    try {
      final fd = FormData.fromMap({
        'file': await MultipartFile.fromFile(pick.path, filename: pick.name),
      });
      await binding.client.uploadPrescriptionFormData(fd);
      await load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Prescription uploaded')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  Future<void> _addAddress(ApiBinding binding) async {
    final line1 = TextEditingController();
    final pin = TextEditingController();
    final city = TextEditingController();

    await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Add address'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: line1, decoration: const InputDecoration(labelText: 'Line 1')),
              TextField(controller: pin, decoration: const InputDecoration(labelText: 'Pincode')),
              TextField(controller: city, decoration: const InputDecoration(labelText: 'City')),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  await binding.client.postProfileAddress({
                    'address_line1': line1.text.trim(),
                    'pincode': pin.text.trim(),
                    'city': city.text.trim(),
                    'is_default': addresses.isEmpty,
                  });
                  if (mounted) Navigator.pop(ctx, true);
                } catch (_) {}
              },
              child: const Text('Save'),
            ),
          ],
        );
      },
    );
    await load();
  }

  Future<void> _addPay(ApiBinding binding) async {
    final upi = TextEditingController();
    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Add UPI (saved for UI parity)'),
          content: TextField(controller: upi, decoration: const InputDecoration(hintText: 'name@upi')),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  await binding.client.postProfilePaymentMethod({
                    'method_type': 'upi',
                    'upi_id': upi.text.trim(),
                    'label': 'UPI',
                    'is_default': payments.isEmpty,
                  });
                  Navigator.pop(ctx);
                } catch (e) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
                }
              },
              child: const Text('Save'),
            ),
          ],
        );
      },
    );
    await load();
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final apiBind = context.read<ApiBinding>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Profile'),
        actions: [
          IconButton(onPressed: load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(12),
              children: [
                if (!auth.isLoggedIn)
                  Card(
                    child: ListTile(
                      title: const Text('Guest mode'),
                      subtitle: const Text('Sign in with OTP to unlock profile endpoints.'),
                      trailing: FilledButton(
                        child: const Text('Login'),
                        onPressed: () =>
                            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen())),
                      ),
                    ),
                  )
                else ...[
                  if ((err ?? '').trim().isNotEmpty) Text(err!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ExpansionTile(title: const Text('Basic'), children: [
                    TextField(controller: _fullName, decoration: const InputDecoration(labelText: 'Full name')),
                    TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email')),
                    TextField(controller: _dob, decoration: const InputDecoration(labelText: 'DOB yyyy-mm-dd')),
                    DropdownButtonFormField<String>(
                      value: ['male', 'female', 'other', 'prefer_not_to_say'].contains(_gender) ? _gender : 'prefer_not_to_say',
                      items: const [
                        DropdownMenuItem(value: 'male', child: Text('Male')),
                        DropdownMenuItem(value: 'female', child: Text('Female')),
                        DropdownMenuItem(value: 'other', child: Text('Other')),
                        DropdownMenuItem(value: 'prefer_not_to_say', child: Text('Prefer not to say')),
                      ],
                      onChanged: (nv) => setState(() => _gender = nv ?? 'prefer_not_to_say'),
                    ),
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: FilledButton(onPressed: () => _saveBasic(apiBind), child: const Text('Save')),
                    ),
                  ]),
                  ExpansionTile(
                    title: Text('Addresses (${addresses.length})'),
                    children: [
                      for (final a in addresses)
                        ListTile(
                          title: Text('${a['label'] ?? 'Address'}'),
                          subtitle: Text('${a['address_line1']}\nPIN ${a['pincode']}'),
                          trailing: IconButton(
                            icon: const Icon(Icons.star_outline),
                            onPressed: () async {
                              try {
                                await apiBind.client.postProfileAddressDefault((a['id'] as num).toInt());
                                await load();
                              } catch (e) {
                                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
                              }
                            },
                          ),
                        ),
                      ListTile(title: TextButton(onPressed: () => _addAddress(apiBind), child: const Text('Add'))),
                    ],
                  ),
                  ExpansionTile(
                    title: Text('Payments (${payments.length})'),
                    children: [
                      for (final p in payments)
                        ListTile(title: Text('${p['label']} (${p['method_type']})'), subtitle: Text('${p['upi_id'] ?? p['card_last4']}')),
                      ListTile(title: TextButton(onPressed: () => _addPay(apiBind), child: const Text('Add UPI'))),
                    ],
                  ),
                  ExpansionTile(
                    title: Text('Prescriptions (${rxList.length})'),
                    children: [
                      for (final p in rxList)
                        ListTile(
                          leading: const Icon(Icons.insert_drive_file),
                          title: Text('${p['original_filename']}'),
                          subtitle: Text('${p['created_at']}'),
                        ),
                      ListTile(title: TextButton(onPressed: () => _uploadRx(apiBind), child: const Text('Upload image/PDF from gallery'))),
                    ],
                  ),
                  ListTile(
                    title: const Text('ABHA & health ID linking'),
                    trailing: const Icon(Icons.link),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AbhaScreen())),
                  ),
                  ListTile(
                    title: const Text('Sign out'),
                    onTap: () async {
                      await auth.signOut(apiBind);
                      await load();
                    },
                  ),
                ],
              ],
            ),
      floatingActionButton: auth.isLoggedIn
          ? FloatingActionButton(
              onPressed: () => _uploadRx(apiBind),
              child: const Icon(Icons.upload_file))
          : null,
    );
  }
}
