import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';
import 'abha_screen.dart';
import 'login_screen.dart';
import 'saved_addresses_screen.dart';
import 'saved_payment_methods_screen.dart';
import 'settings_sheet.dart';

/// Stitch “Profile · PaxMed” tokens (tailwind excerpt).
abstract final class _ProfileTheme {
  static const bg = Color(0xFFF7F9FB);
  static const slateMuted = Color(0xFF64748B);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const primary = Color(0xFF006194);
  static const tealLight = Color(0xFF2DD4BF);
  static const tealDark = Color(0xFF0C2451);
  static const surfaceContainer = Color(0xFFECEEF0);
  static const surfaceWhite = Color(0xFFFFFFFF);
  static const errorRed = Color(0xFFB42318);
  static const errorContainerTint = Color(0xFFFFF1F0);
  /// ~rgba(0,97,148,0.05)
  static const gridLine = Color(0x0D006194);
}

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, this.embedded = false});

  final bool embedded;

  /// Display version line (sync with pubspec.yaml when bumping releases).
  static const displayVersionLabel = '1.0.0+1';

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Map<String, dynamic>? profile;
  Map<String, dynamic>? abhaSummary;
  List<Map<String, dynamic>> addresses = [];
  List<Map<String, dynamic>> payments = [];
  List<Map<String, dynamic>> rxList = [];
  List<Map<String, dynamic>> diagnosticReports = [];

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

      abhaSummary = null;
      final abRaw = b['abha'];
      if (abRaw is Map<String, dynamic>) {
        abhaSummary = Map<String, dynamic>.from(abRaw);
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

      diagnosticReports = [];
      final drRaw = b['diagnostic_reports'];
      if (drRaw is List) {
        diagnosticReports = drRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      }

      _fullName.text = '${profile?['full_name'] ?? ''}';
      _email.text = '${profile?['email'] ?? ''}';
      final dob = '${profile?['date_of_birth'] ?? ''}';
      if (dob.trim().isNotEmpty && dob != 'null') _dob.text = dob;
      final g = '${profile?['gender'] ?? ''}'.trim();
      if (g.isNotEmpty && ['male', 'female', 'other', 'prefer_not_to_say'].contains(g)) {
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
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_initLoad());
    });
  }

  Future<void> _initLoad() async {
    if (!mounted) return;
    if (!context.read<AuthState>().isLoggedIn) return;
    await load();
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
      if (!mounted) return;
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

  Future<void> _openSavedAddresses() async {
    await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => const SavedAddressesScreen()));
    if (mounted) await load();
  }

  Future<void> _openSavedPaymentMethods() async {
    await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => const SavedPaymentMethodsScreen()));
    if (mounted) await load();
  }

  String _displayName(AuthState auth) {
    final n = _fullName.text.trim();
    if (n.isNotEmpty) return n;
    return auth.phoneE164 ?? 'PaxMed user';
  }

  static String _twoChars(String s) {
    final t = s.trim();
    if (t.isEmpty) return '?';
    if (t.runes.length >= 2) return String.fromCharCodes(t.runes.take(2)).toUpperCase();
    return t.toUpperCase();
  }

  String _initialsFromName(AuthState auth) {
    final n = _displayName(auth);
    final parts = n.split(RegExp(r'\s+')).where((e) => e.isNotEmpty).toList();
    if (parts.isEmpty) return 'P';
    if (parts.length == 1) return _twoChars(parts.first);
    final a = parts.first.runes.first;
    final b = parts.last.runes.first;
    return String.fromCharCodes([a, b]).toUpperCase();
  }

  String? _phoneLine(AuthState auth) {
    final p = auth.phoneE164?.trim();
    if (p != null && p.isNotEmpty) return p;
    return null;
  }

  String _primaryAddressText() {
    if (addresses.isEmpty) return 'Add a delivery address';
    Map<String, dynamic>? def;
    for (final a in addresses) {
      if (a['is_default'] == true) {
        def = a;
        break;
      }
    }
    def ??= addresses.first;
    final line1 = '${def['address_line1'] ?? ''}'.trim();
    final city = '${def['city'] ?? ''}'.trim();
    final state = '${def['state'] ?? ''}'.trim();
    final pin = '${def['pincode'] ?? ''}'.trim();
    final tail = [city, state, pin].where((e) => e.isNotEmpty).join(', ');
    if (line1.isEmpty && tail.isEmpty) return 'Saved address';
    if (tail.isEmpty) return line1;
    if (line1.isEmpty) return tail;
    return '$line1, $tail';
  }

  void _toast(String m) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  Future<void> _showBasicEditor(ApiBinding binding) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) {
        return Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(ctx).bottom),
          child: DraggableScrollableSheet(
            initialChildSize: 0.72,
            minChildSize: 0.45,
            maxChildSize: 0.94,
            expand: false,
            builder: (_, scroll) => Material(
              color: _ProfileTheme.surfaceWhite,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
              clipBehavior: Clip.antiAlias,
              child: ListView(
                controller: scroll,
                padding: const EdgeInsets.all(24),
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(2)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text('Edit profile', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 20),
                  TextField(controller: _fullName, decoration: const InputDecoration(labelText: 'Full name')),
                  const SizedBox(height: 12),
                  TextField(controller: _email, decoration: const InputDecoration(labelText: 'Email')),
                  const SizedBox(height: 12),
                  TextField(controller: _dob, decoration: const InputDecoration(labelText: 'DOB yyyy-mm-dd')),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                    initialValue:
                        ['male', 'female', 'other', 'prefer_not_to_say'].contains(_gender) ? _gender : 'prefer_not_to_say',
                    items: const [
                      DropdownMenuItem(value: 'male', child: Text('Male')),
                      DropdownMenuItem(value: 'female', child: Text('Female')),
                      DropdownMenuItem(value: 'other', child: Text('Other')),
                      DropdownMenuItem(value: 'prefer_not_to_say', child: Text('Prefer not to say')),
                    ],
                    onChanged: (nv) => setState(() => _gender = nv ?? 'prefer_not_to_say'),
                    decoration: const InputDecoration(labelText: 'Gender'),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(onPressed: () async {
                    Navigator.pop(ctx);
                    await _saveBasic(binding);
                  }, child: const Text('Save')),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _showPrescriptionsSheet(ApiBinding binding) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: DraggableScrollableSheet(
              expand: false,
              initialChildSize: 0.55,
              minChildSize: 0.35,
              maxChildSize: 0.92,
              builder: (_, sc) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Saved Prescriptions', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  FilledButton.icon(
                    onPressed: () async {
                      Navigator.pop(ctx);
                      await _uploadRx(binding);
                    },
                    icon: const Icon(Icons.upload_file),
                    label: const Text('Upload from gallery'),
                  ),
                  const SizedBox(height: 12),
                  Expanded(
                    child: ListView(
                      controller: sc,
                      children: [
                        for (final p in rxList)
                          ListTile(
                            leading: const Icon(Icons.insert_drive_file_outlined),
                            title: Text('${p['original_filename']}'),
                            subtitle: Text('${p['created_at']}'),
                          ),
                        if (rxList.isEmpty) const ListTile(title: Text('No files yet')),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _showReportsSheet() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: DraggableScrollableSheet(
              expand: false,
              initialChildSize: 0.5,
              minChildSize: 0.35,
              maxChildSize: 0.92,
              builder: (_, sc) => Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Saved Reports', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 12),
                  Expanded(
                    child: ListView(
                      controller: sc,
                      children: [
                        if (diagnosticReports.isEmpty)
                          const ListTile(
                            title: Text('No lab reports yet'),
                            subtitle: Text('Book a diagnostic test to see reports here after they are synced.'),
                          )
                        else
                          for (final r in diagnosticReports)
                            ListTile(
                              leading: const Icon(Icons.description_outlined),
                              title: Text('${r['title'] ?? r['test_name'] ?? 'Report'}'),
                              subtitle: Text('${r['created_at'] ?? r['reported_at'] ?? ''}'),
                            ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _topBarStandalone() => Material(
        color: Colors.white.withValues(alpha: 0.94),
        child: SizedBox(
          height: kToolbarHeight,
          child: Row(
            children: [
              IconButton(
                onPressed: () => Navigator.maybeOf(context)?.pop(),
                icon: const Icon(Icons.arrow_back_rounded),
                color: _ProfileTheme.primary,
              ),
              const Expanded(
                child: Text(
                  'Profile',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 28,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    color: _ProfileTheme.primary,
                  ),
                ),
              ),
              IconButton(
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => const SettingsSheet(),
                ),
                icon: const Icon(Icons.settings_rounded),
                color: _ProfileTheme.primary,
              ),
            ],
          ),
        ),
      );

  Widget _guestBody() => Padding(
        padding: _contentPadding(),
        child: Card(
          child: ListTile(
            title: const Text('Guest mode'),
            subtitle: const Text('Sign in with OTP to unlock your profile.'),
            trailing: FilledButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen())),
              child: const Text('Login'),
            ),
          ),
        ),
      );

  EdgeInsets _contentPadding() {
    final navPad = widget.embedded ? 100.0 : 32.0;
    final topInset = widget.embedded ? 8.0 : 8.0;
    return EdgeInsets.fromLTRB(20, topInset, 20, navPad);
  }

  Widget _detailRowIcon({required IconData icon, required String kicker, required String value}) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: _ProfileTheme.tealLight, size: 22),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    kicker,
                    style: const TextStyle(
                      fontSize: 11,
                      height: 1.25,
                      letterSpacing: 1.35,
                      fontWeight: FontWeight.w700,
                      color: _ProfileTheme.slateMuted,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(value, style: const TextStyle(fontSize: 16, height: 1.5)),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _savedMenuCard(ApiBinding binding) => Container(
        decoration: BoxDecoration(
          color: _ProfileTheme.surfaceWhite,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _ProfileTheme.outlineVariant.withValues(alpha: 0.35)),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF12202F).withValues(alpha: 0.04),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            _menuRow(Icons.home_rounded, 'Saved Addresses', () {
              _openSavedAddresses();
            }),
            const Divider(height: 1),
            _menuRow(Icons.credit_card_rounded, 'Saved Payment Details', () {
              _openSavedPaymentMethods();
            }),
            const Divider(height: 1),
            _menuRow(Icons.description_outlined, 'Saved Reports', _showReportsSheet),
            const Divider(height: 1),
            _menuRow(Icons.medication_rounded, 'Saved Prescriptions', () => _showPrescriptionsSheet(binding)),
          ],
        ),
      );

  Widget _menuRow(IconData icon, String title, VoidCallback onTap) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        splashColor: _ProfileTheme.primary.withValues(alpha: 0.07),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(10),
                  color: _ProfileTheme.surfaceContainer,
                ),
                child: Icon(icon, color: _ProfileTheme.tealLight),
              ),
              const SizedBox(width: 16),
              Expanded(child: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
              const Icon(Icons.chevron_right_rounded, color: _ProfileTheme.outline),
            ],
          ),
        ),
      ),
    );
  }

  Widget _abhaCard(AuthState auth) => Material(
        color: _ProfileTheme.tealDark,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        elevation: 4,
        shadowColor: Colors.black.withValues(alpha: 0.2),
        child: InkWell(
          onTap: () =>
              Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AbhaScreen())).then((_) => load()),
          child: Stack(
            children: [
              Positioned(
                right: -36,
                top: -44,
                child: IgnorePointer(
                  child: Container(
                    width: 120,
                    height: 120,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: _ProfileTheme.tealLight.withValues(alpha: 0.1),
                      boxShadow: [
                        BoxShadow(
                          color: _ProfileTheme.tealLight.withValues(alpha: 0.05),
                          blurRadius: 40,
                          spreadRadius: 20,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(22),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.verified_user_rounded, color: _ProfileTheme.tealLight, size: 22),
                        const SizedBox(width: 10),
                        const Text(
                          'DIGITAL HEALTH CARD',
                          style: TextStyle(
                            fontSize: 11,
                            letterSpacing: 2.8,
                            fontWeight: FontWeight.w700,
                            height: 1.2,
                            color: Colors.white,
                          ),
                        ),
                        const Spacer(),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            'ABHA',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 2,
                              color: Colors.white.withValues(alpha: 0.94),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'ABHA ID',
                      style: TextStyle(fontSize: 11, letterSpacing: 2, height: 1.25, fontWeight: FontWeight.w700, color: Color(0xB32DD4BF)),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      auth.isLoggedIn && abhaSummary?['linked'] == true
                          ? '${abhaSummary!['health_id_masked'] ?? 'Linked'}'
                          : 'Tap to link your ABHA',
                      style: const TextStyle(
                        fontSize: 21,
                        height: 1.15,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.2,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(height: 22),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'AADHAAR LINK',
                                style: TextStyle(
                                  fontSize: 11,
                                  letterSpacing: 2,
                                  fontWeight: FontWeight.w700,
                                  color: _ProfileTheme.tealLight.withValues(alpha: 0.7),
                                ),
                              ),
                              const SizedBox(height: 10),
                              Text(
                                auth.isLoggedIn && abhaSummary?['aadhaar_verified_at'] != null
                                    ? 'Verified'
                                    : 'Not verified',
                                style: const TextStyle(fontSize: 16, letterSpacing: 2, fontWeight: FontWeight.w500, color: Colors.white),
                              ),
                            ],
                          ),
                        ),
                        IconButton(
                          style: IconButton.styleFrom(
                            foregroundColor: Colors.white,
                            backgroundColor: Colors.white.withValues(alpha: 0.1),
                          ),
                          onPressed: () => _toast('QR coming soon'),
                          icon: const Icon(Icons.qr_code_2_rounded),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );

  Widget _logoutButton(AuthState auth, ApiBinding binding) => OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: _ProfileTheme.errorRed,
          padding: const EdgeInsets.symmetric(vertical: 16),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          side: BorderSide(color: _ProfileTheme.errorRed.withValues(alpha: 0.25)),
          backgroundColor: _ProfileTheme.errorContainerTint.withValues(alpha: 0.45),
        ),
        onPressed: () async {
          await auth.signOut(binding);
          await load();
        },
        child: const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.logout_rounded, size: 22),
            SizedBox(width: 10),
            Text('Logout', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
          ],
        ),
      );

  Widget _loggedInBody(AuthState auth, ApiBinding binding) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: _contentPadding(),
        children: [
          const SizedBox(height: 12),
          if ((err ?? '').trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(err!, style: const TextStyle(color: _ProfileTheme.errorRed)),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  CircleAvatar(
                    radius: 42,
                    backgroundColor: Colors.white,
                    foregroundColor: _ProfileTheme.primary,
                    child: Text(
                      _initialsFromName(auth),
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                    ),
                  ),
                  Positioned(
                    right: -2,
                    bottom: -2,
                    child: Material(
                      color: _ProfileTheme.tealLight,
                      shape: const CircleBorder(side: BorderSide(color: Colors.white, width: 2)),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: () => _showBasicEditor(binding),
                        child: const Padding(
                          padding: EdgeInsets.all(6),
                          child: Icon(Icons.edit_rounded, size: 16, color: Colors.white),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 18),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _displayName(auth),
                        style: const TextStyle(fontSize: 20, height: 1.35, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'PREMIUM MEMBER',
                        style: TextStyle(
                          fontSize: 11,
                          letterSpacing: 1.85,
                          fontWeight: FontWeight.w700,
                          height: 1.25,
                          color: _ProfileTheme.tealDark.withValues(alpha: 0.72),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 26),
          Container(
            decoration: BoxDecoration(
              color: _ProfileTheme.surfaceWhite,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: _ProfileTheme.outlineVariant.withValues(alpha: 0.35)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF12202F).withValues(alpha: 0.04),
                  blurRadius: 10,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _detailRowIcon(
                  icon: Icons.mail_outline_rounded,
                  kicker: 'EMAIL ADDRESS',
                  value: _email.text.trim().isEmpty ? '—' : _email.text.trim(),
                ),
                if (_phoneLine(auth) != null)
                  _detailRowIcon(
                    icon: Icons.call_rounded,
                    kicker: 'PHONE NUMBER',
                    value: _phoneLine(auth)!,
                  ),
                _detailRowIcon(
                  icon: Icons.location_on_outlined,
                  kicker: 'PRIMARY ADDRESS',
                  value: _primaryAddressText(),
                ),
              ],
            ),
          ),
          const SizedBox(height: 22),
          _abhaCard(auth),
          const SizedBox(height: 28),
          const Padding(
            padding: EdgeInsets.only(left: 4, bottom: 12),
            child: Text('Saved Records & Details', style: TextStyle(fontSize: 20, height: 1.4, fontWeight: FontWeight.w600)),
          ),
          _savedMenuCard(binding),
          const SizedBox(height: 24),
          _logoutButton(auth, binding),
          const SizedBox(height: 22),
          Center(
            child: Text(
              'PaxMed App Version ${ProfileScreen.displayVersionLabel} (Stable)',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, height: 1.35, color: _ProfileTheme.slateMuted.withValues(alpha: 0.65)),
            ),
          ),
        ],
      );

  Widget _stackedShell({required Widget child}) => Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _ProfileGridPainter())),
          child,
        ],
      );

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final apiBind = context.read<ApiBinding>();

    Widget content;
    if (!auth.isLoggedIn) {
      content = RefreshIndicator(
        color: _ProfileTheme.primary,
        onRefresh: load,
        child: LayoutBuilder(
          builder: (_, c) => SingleChildScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight),
              child: _stackedShell(child: _guestBody()),
            ),
          ),
        ),
      );
    } else if (loading) {
      content = _stackedShell(
        child: const Center(child: CircularProgressIndicator(color: _ProfileTheme.primary)),
      );
    } else {
      content = RefreshIndicator(
        color: _ProfileTheme.primary,
        onRefresh: () async {
          if (auth.isLoggedIn) await load();
        },
        child: _stackedShell(child: _loggedInBody(auth, apiBind)),
      );
    }

    final body = ColoredBox(color: _ProfileTheme.bg, child: content);

    if (widget.embedded) {
      return body;
    }

    return Scaffold(
      backgroundColor: _ProfileTheme.bg,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(kToolbarHeight),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.94),
            border: Border(bottom: BorderSide(color: _ProfileTheme.outlineVariant.withValues(alpha: 0.35))),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.05),
                blurRadius: 6,
                offset: const Offset(0, 1),
              ),
            ],
          ),
          child: SafeArea(bottom: false, child: _topBarStandalone()),
        ),
      ),
      body: body,
      floatingActionButton: auth.isLoggedIn && !loading
          ? FloatingActionButton(
              tooltip: 'Upload prescription',
              onPressed: () => _uploadRx(apiBind),
              child: const Icon(Icons.upload_file_rounded),
            )
          : null,
    );
  }
}

/// Lightly stronger grid vs orders (Tailwind `.bg-grid` ~5% lines).
class _ProfileGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const step = 48.0;
    final p = Paint()
      ..color = _ProfileTheme.gridLine
      ..strokeWidth = 1;
    for (var x = 0.0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), p);
    }
    for (var y = 0.0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
