import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';

/// Stitch-inspired “Saved Addresses” mobile layout.
abstract final class _AddrTheme {
  static const bg = Color(0xFFF7F9FB);
  /// ~rgba(0,97,148,0.03) square grid lines
  static const gridLine = Color(0x08006194);
  static const surfaceContainer = Color(0xFFECEEF0);
  static const surfaceLowest = Color(0xFFFFFFFF);
  static const onSurfaceVariant = Color(0xFF3F4850);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const primary = Color(0xFF006194);
  static const secondary = Color(0xFF006B5F);
  static const tertiary = Color(0xFF831ADA);
  static const tealDark = Color(0xFF0C2451);
  static const error = Color(0xFFBA1A1A);
  static const errorRed = Color(0xFFB42318);
}

class SavedAddressesScreen extends StatefulWidget {
  const SavedAddressesScreen({super.key});

  @override
  State<SavedAddressesScreen> createState() => _SavedAddressesScreenState();
}

class _SavedAddressesScreenState extends State<SavedAddressesScreen> {
  final _searchCtrl = TextEditingController();
  List<Map<String, dynamic>> _addresses = [];
  bool _loading = true;
  String? _err;

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!context.read<AuthState>().isLoggedIn) {
      setState(() {
        _loading = false;
        _addresses = [];
      });
      return;
    }
    setState(() {
      _loading = true;
      _err = null;
    });
    try {
      final b = await context.read<ApiBinding>().client.getProfileBundle();
      final adRaw = b['addresses'];
      final list = adRaw is List ? adRaw : <dynamic>[];
      _addresses = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _err = '$e';
    }
    setState(() => _loading = false);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    _searchCtrl.addListener(() => setState(() {}));
  }

  Iterable<Map<String, dynamic>> get _filtered {
    final q = _searchCtrl.text.trim().toLowerCase();
    if (q.isEmpty) return _addresses;
    return _addresses.where((a) {
      final hay = '${a['label']} ${a['address_line1']} ${a['address_line2']} ${a['city']} ${a['pincode']} ${a['state']}'
          .toLowerCase();
      return hay.contains(q);
    });
  }

  static String _lineBody(Map<String, dynamic> a) {
    final l1 = '${a['address_line1'] ?? ''}'.trim();
    final l2 = '${a['address_line2'] ?? ''}'.trim();
    final city = '${a['city'] ?? ''}'.trim();
    final st = '${a['state'] ?? ''}'.trim();
    final pin = '${a['pincode'] ?? ''}'.trim();
    final row2 = [
      city,
      st,
      pin,
    ].where((s) => s.trim().isNotEmpty).join(', ');
    final lines = <String>[
      l1,
      if (l2.isNotEmpty) l2,
      if (row2.isNotEmpty) row2,
    ];
    return lines.join('\n');
  }

  static ({IconData icon, Color fg, Color bg}) _iconTone(Map<String, dynamic> a) {
    final label = '${a['label'] ?? ''}'.toLowerCase();
    if (label.contains('home') || label.contains('house')) {
      return (
        icon: Icons.home_rounded,
        fg: _AddrTheme.secondary,
        bg: _AddrTheme.secondary.withValues(alpha: 0.1),
      );
    }
    if (label.contains('work') || label.contains('office')) {
      return (
        icon: Icons.work_rounded,
        fg: _AddrTheme.primary,
        bg: _AddrTheme.primary.withValues(alpha: 0.1),
      );
    }
    return (
      icon: Icons.groups_rounded,
      fg: _AddrTheme.tertiary,
      bg: _AddrTheme.tertiary.withValues(alpha: 0.1),
    );
  }

  Future<void> _confirmDelete(ApiBinding api, Map<String, dynamic> addr) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove address?'),
        content: const Text('This address will be removed from saved locations.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _AddrTheme.error),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await api.client.deleteProfileAddress((addr['id'] as num).toInt());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Address removed')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _showEditor({Map<String, dynamic>? existing}) async {
    final api = context.read<ApiBinding>();
    final label = TextEditingController(text: existing == null ? '' : '${existing['label'] ?? ''}');
    final line1 = TextEditingController(text: existing == null ? '' : '${existing['address_line1'] ?? ''}');
    final line2 = TextEditingController(text: existing == null ? '' : '${existing['address_line2'] ?? ''}');
    final landmark = TextEditingController(text: existing == null ? '' : '${existing['landmark'] ?? ''}');
    final city = TextEditingController(text: existing == null ? '' : '${existing['city'] ?? ''}');
    final state = TextEditingController(text: existing == null ? '' : '${existing['state'] ?? ''}');
    final pin = TextEditingController(text: existing == null ? '' : '${existing['pincode'] ?? ''}');
    final phone = TextEditingController(text: existing == null ? '' : '${existing['phone_e164'] ?? ''}');
    var isDefault = existing?['is_default'] == true;

    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setModal) {
            return AlertDialog(
              title: Text(existing == null ? 'New address' : 'Edit address'),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(controller: label, decoration: const InputDecoration(labelText: 'Label (e.g. Home)')),
                    TextField(controller: line1, decoration: const InputDecoration(labelText: 'Address line 1')),
                    TextField(controller: line2, decoration: const InputDecoration(labelText: 'Address line 2')),
                    TextField(controller: landmark, decoration: const InputDecoration(labelText: 'Landmark')),
                    TextField(controller: city, decoration: const InputDecoration(labelText: 'City')),
                    TextField(controller: state, decoration: const InputDecoration(labelText: 'State')),
                    TextField(controller: pin, decoration: const InputDecoration(labelText: 'Pincode')),
                    TextField(controller: phone, decoration: const InputDecoration(labelText: 'Phone (optional)')),
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Default address'),
                      value: isDefault,
                      activeThumbColor: _AddrTheme.secondary,
                      onChanged: (v) => setModal(() => isDefault = v),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: _AddrTheme.secondary, foregroundColor: Colors.white),
                  onPressed: () async {
                    final body = {
                      if (label.text.trim().isNotEmpty) 'label': label.text.trim(),
                      'address_line1': line1.text.trim(),
                      if (line2.text.trim().isNotEmpty) 'address_line2': line2.text.trim(),
                      if (landmark.text.trim().isNotEmpty) 'landmark': landmark.text.trim(),
                      if (city.text.trim().isNotEmpty) 'city': city.text.trim(),
                      if (state.text.trim().isNotEmpty) 'state': state.text.trim(),
                      if (pin.text.trim().isNotEmpty) 'pincode': pin.text.trim(),
                      if (phone.text.trim().isNotEmpty) 'phone_e164': phone.text.trim(),
                      'is_default': isDefault,
                    };
                    if (body['address_line1'] == null || '${body['address_line1']}'.trim().isEmpty) {
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Address line 1 required')));
                      return;
                    }
                    try {
                      if (existing == null) {
                        await api.client.postProfileAddress(body);
                      } else {
                        await api.client.putProfileAddress((existing['id'] as num).toInt(), body);
                      }
                      if (ctx.mounted) Navigator.pop(ctx);
                      await _load();
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Address saved')));
                    } catch (e) {
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
                    }
                  },
                  child: const Text('Save'),
                ),
              ],
            );
          },
        );
      },
    );

    label.dispose();
    line1.dispose();
    line2.dispose();
    landmark.dispose();
    city.dispose();
    state.dispose();
    pin.dispose();
    phone.dispose();
  }

  Widget _addressCard(ApiBinding api, Map<String, dynamic> a) {
    final tone = _iconTone(a);
    final title = '${a['label'] ?? 'Address'}'.trim();
    final body = _lineBody(a);

    return Material(
      color: _AddrTheme.surfaceLowest,
      elevation: 0,
      shadowColor: const Color(0xFF12202F).withValues(alpha: 0.08),
      borderRadius: BorderRadius.circular(14),
      child: Ink(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _AddrTheme.outlineVariant.withValues(alpha: 0.28)),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF12202F).withValues(alpha: 0.04),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(shape: BoxShape.circle, color: tone.bg),
                      alignment: Alignment.center,
                      child: Icon(tone.icon, color: tone.fg, size: 22),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 8,
                            runSpacing: 4,
                            children: [
                              Text(
                                title.isEmpty ? 'Address' : title,
                                style: const TextStyle(fontSize: 16, height: 1.25, fontWeight: FontWeight.w600),
                              ),
                              if (a['is_default'] == true)
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                                  decoration: BoxDecoration(
                                    color: _AddrTheme.secondary.withValues(alpha: 0.1),
                                    borderRadius: BorderRadius.circular(999),
                                  ),
                                  child: Text(
                                    'DEFAULT',
                                    style: TextStyle(
                                      fontSize: 10,
                                      height: 1.15,
                                      letterSpacing: 0.6,
                                      fontWeight: FontWeight.w800,
                                      color: _AddrTheme.secondary,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          Text(
                            body,
                            style: const TextStyle(
                              fontSize: 14,
                              height: 1.38,
                              fontWeight: FontWeight.w500,
                              color: _AddrTheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Divider(height: 1, thickness: 1, color: _AddrTheme.outlineVariant.withValues(alpha: 0.13)),
              Row(
                children: [
                  Expanded(
                    child: Material(
                      color: _AddrTheme.surfaceContainer,
                      child: InkWell(
                        splashColor: _AddrTheme.primary.withValues(alpha: 0.08),
                        highlightColor: _AddrTheme.surfaceContainer.withValues(alpha: 0.5),
                        onTap: () => _showEditor(existing: a),
                        child: const Padding(
                          padding: EdgeInsets.symmetric(vertical: 13),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.edit_rounded, size: 18, color: _AddrTheme.onSurfaceVariant),
                              SizedBox(width: 8),
                              Text(
                                'Edit',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: Color(0xFF191C1E),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Material(
                      color: _AddrTheme.surfaceContainer,
                      child: InkWell(
                        splashColor: const Color(0xFFFFDAD6).withValues(alpha: 0.7),
                        highlightColor: const Color(0xFFFFDAD6).withValues(alpha: 0.35),
                        onTap: () => _confirmDelete(api, a),
                        child: const Padding(
                          padding: EdgeInsets.symmetric(vertical: 13),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.delete_outline_rounded, size: 18, color: Color(0xFFB42318)),
                              SizedBox(width: 8),
                              Text(
                                'Delete',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: Color(0xFF191C1E),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _emptyState(bool searchEmpty) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 180,
                height: 180,
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: Color(0xFFF2F4F6),
                ),
                child: const Icon(Icons.location_off_rounded, size: 76, color: _AddrTheme.outlineVariant),
              ),
              const SizedBox(height: 22),
              Text(
                searchEmpty ? 'No matches' : 'No addresses saved yet',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 12),
              Text(
                searchEmpty
                    ? 'Try a different search.'
                    : 'Save your frequent delivery spots for faster checkout.',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 16, height: 1.45, color: _AddrTheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      );

  Widget _mapTeaserCard() => Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: () =>
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Map view is coming soon.'))),
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: _AddrTheme.outlineVariant.withValues(alpha: 0.35)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF12202F).withValues(alpha: 0.06),
                  blurRadius: 8,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: SizedBox(
              height: 128,
              width: double.infinity,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(13),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    const CustomPaint(painter: _FakeMapPainter()),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            _AddrTheme.bg.withValues(alpha: 0.05),
                            _AddrTheme.tealDark.withValues(alpha: 0.58),
                          ],
                        ),
                      ),
                    ),
                    Positioned(
                      left: 16,
                      right: 16,
                      bottom: 14,
                      child: Row(
                        children: [
                          const Icon(Icons.map_rounded, color: Colors.white, size: 20),
                          const SizedBox(width: 10),
                          const Text(
                            'View all on map',
                            style: TextStyle(
                              color: Colors.white,
                              fontSize: 14,
                              height: 1.2,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );

  Widget _searchField() => TextField(
        controller: _searchCtrl,
        style: const TextStyle(fontSize: 16),
        decoration: InputDecoration(
          filled: true,
          fillColor: _AddrTheme.surfaceLowest,
          hintText: 'Search saved locations…',
          hintStyle: TextStyle(color: _AddrTheme.outline.withValues(alpha: 0.9)),
          prefixIcon: const Icon(Icons.search_rounded, color: _AddrTheme.outline),
          contentPadding: const EdgeInsets.symmetric(vertical: 16, horizontal: 16),
          border: const OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(14)),
            borderSide: BorderSide(color: _AddrTheme.outlineVariant),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radius.circular(14)),
            borderSide: BorderSide(color: _AddrTheme.outlineVariant.withValues(alpha: 0.5)),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: const BorderRadius.all(Radius.circular(14)),
            borderSide: BorderSide(color: _AddrTheme.secondary.withValues(alpha: 0.75), width: 2),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final api = context.read<ApiBinding>();

    Widget bodyInner;
    if (!auth.isLoggedIn) {
      bodyInner = const Center(child: Text('Sign in to manage addresses.'));
    } else if (_loading) {
      bodyInner = const Center(child: CircularProgressIndicator(color: _AddrTheme.primary));
    } else if ((_err ?? '').isNotEmpty) {
      bodyInner = Center(child: Padding(padding: const EdgeInsets.all(16), child: Text(_err!)));
    } else {
      final rows = _filtered.toList();
      if (_addresses.isEmpty) {
        bodyInner = RefreshIndicator(color: _AddrTheme.primary, onRefresh: _load, child: ListView(children: [_emptyState(false)]));
      } else if (rows.isEmpty) {
        bodyInner = RefreshIndicator(
          color: _AddrTheme.primary,
          onRefresh: _load,
          child: LayoutBuilder(
            builder: (_, c) => SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: c.maxHeight),
                child: _emptyState(true),
              ),
            ),
          ),
        );
      } else {
        bodyInner = RefreshIndicator(
          color: _AddrTheme.primary,
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 200),
            children: [
              for (final a in rows) ...[
                _addressCard(api, a),
                const SizedBox(height: 16),
              ],
              _mapTeaserCard(),
              const SizedBox(height: 24),
            ],
          ),
        );
      }
    }

    return Scaffold(
      backgroundColor: _AddrTheme.bg,
      extendBody: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        flexibleSpace: Container(
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.94),
            border: Border(bottom: BorderSide(color: _AddrTheme.outlineVariant.withValues(alpha: 0.3))),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.05),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
        ),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded, color: _AddrTheme.primary, size: 26),
          onPressed: () => Navigator.maybeOf(context)?.pop(),
        ),
        title: const Text(
          'Saved Addresses',
          style: TextStyle(fontSize: 20, height: 1.4, fontWeight: FontWeight.w600, color: _AddrTheme.primary),
        ),
        actions: [
          PopupMenuButton<String>(
            icon: Icon(Icons.more_vert_rounded, color: Theme.of(context).colorScheme.onSurfaceVariant),
            onSelected: (v) {
              if (v == 'refresh') _load();
              if (v == 'add') _showEditor();
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'add', child: Text('Add address')),
              const PopupMenuItem(value: 'refresh', child: Text('Refresh')),
            ],
          ),
        ],
      ),
      body: Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _AddressGridPainter())),
          Column(
            children: [
              if (auth.isLoggedIn && !_loading && (_err ?? '').isEmpty) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 20, 22),
                  child: _searchField(),
                ),
              ],
              Expanded(child: bodyInner),
            ],
          ),
          if (auth.isLoggedIn && !_loading && (_err ?? '').isEmpty)
            Positioned(
              right: 22,
              bottom: 132 + MediaQuery.paddingOf(context).bottom,
              child: FloatingActionButton(
                elevation: 8,
                backgroundColor: _AddrTheme.secondary,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                onPressed: () => _showEditor(),
                heroTag: 'saved_addresses_add_fab',
                child: const Icon(Icons.add_location_alt_rounded, size: 28),
              ),
            ),
          if (auth.isLoggedIn && !_loading && (_err ?? '').isEmpty)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.bottomCenter,
                    end: Alignment.topCenter,
                    colors: [
                      _AddrTheme.bg,
                      _AddrTheme.bg.withValues(alpha: 0.94),
                      _AddrTheme.bg.withValues(alpha: 0),
                    ],
                    stops: const [0.0, 0.45, 1.0],
                  ),
                ),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(20, 24, 20, MediaQuery.paddingOf(context).bottom + 18),
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: _AddrTheme.secondary,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      elevation: 6,
                    ),
                    onPressed: () => _showEditor(),
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('Add New Address', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AddressGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = _AddrTheme.gridLine
      ..strokeWidth = 1;
    const step = 48.0;
    for (var x = 0.0; x <= size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), p);
    }
    for (var y = 0.0; y <= size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Soft map backdrop (placeholder; no tile fetch).
class _FakeMapPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final base = Paint()..color = const Color(0xFFEEF4F6);
    canvas.drawRect(Offset.zero & size, base);

    final road = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 2
      ..color = _AddrTheme.secondary.withValues(alpha: 0.25);
    final road2 = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = 1.4
      ..color = _AddrTheme.primary.withValues(alpha: 0.22);

    final r = Rect.fromLTWH(size.width * 0.06, size.height * 0.18, size.width * 0.88, size.height * 0.72);
    canvas.drawRRect(RRect.fromRectAndRadius(r, const Radius.circular(6)), Paint()..color = Colors.white.withValues(alpha: 0.35));

    final p1 = Offset(0, size.height * 0.42);
    final p2 = Offset(size.width * 1.08, size.height * 0.38);
    canvas.drawLine(p1, p2, road);
    canvas.drawLine(Offset(size.width * 0.08, size.height * 0.92), Offset(size.width * 0.55, size.height * 0.06), road2);

    canvas.drawCircle(Offset(size.width * 0.52, size.height * 0.48), 6, Paint()..color = _AddrTheme.secondary);
    canvas.drawCircle(Offset(size.width * 0.52, size.height * 0.48), 10.5, Paint()
      ..color = _AddrTheme.secondary.withValues(alpha: 0.35)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
