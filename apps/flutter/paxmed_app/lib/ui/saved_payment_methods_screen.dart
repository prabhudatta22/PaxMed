import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';

/// Stitch-inspired Payment Methods layout (cards + UPI + trust banner + footer CTA).
abstract final class _PayTheme {
  static const bg = Color(0xFFF7F9FB);
  static const gridLine = Color(0x08006194); // ~rgba(0,97,148,0.03) on pale bg
  static const onSurface = Color(0xFF191C1E);
  static const onSurfaceVariant = Color(0xFF3F4850);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const primary = Color(0xFF006194);
  static const primaryContainer = Color(0xFF007BB9);
  static const secondary = Color(0xFF006B5F);
  static const secondaryContainer = Color(0xFF6DF5E1);
  static const onSecondaryContainer = Color(0xFF006F64);
  static const error = Color(0xFFBA1A1A);
}

class SavedPaymentMethodsScreen extends StatefulWidget {
  const SavedPaymentMethodsScreen({super.key});

  @override
  State<SavedPaymentMethodsScreen> createState() => _SavedPaymentMethodsScreenState();
}

class _SavedPaymentMethodsScreenState extends State<SavedPaymentMethodsScreen> {
  List<Map<String, dynamic>> _methods = [];
  bool _loading = true;
  String? _err;
  int? _focusedId;

  Future<void> _load() async {
    if (!context.read<AuthState>().isLoggedIn) {
      setState(() {
        _loading = false;
        _methods = [];
      });
      return;
    }
    setState(() {
      _loading = true;
      _err = null;
    });
    try {
      final b = await context.read<ApiBinding>().client.getProfileBundle();
      final raw = b['payment_methods'];
      final list = raw is List ? raw : <dynamic>[];
      _methods = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _err = '$e';
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  List<Map<String, dynamic>> get _cards =>
      _methods.where((m) => '${m['method_type'] ?? ''}'.toLowerCase() == 'card').toList();

  List<Map<String, dynamic>> get _upis =>
      _methods.where((m) => '${m['method_type'] ?? ''}'.toLowerCase() == 'upi').toList();

  Future<void> _setDefault(ApiBinding api, Map<String, dynamic> pm) async {
    if (pm['is_default'] == true) return;
    try {
      await api.client.postProfilePaymentMethodDefault((pm['id'] as num).toInt());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Default payment method updated')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _confirmDelete(ApiBinding api, Map<String, dynamic> pm) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove payment method?'),
        content: const Text('You can add this again later from your profile.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _PayTheme.error),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await api.client.deleteProfilePaymentMethod((pm['id'] as num).toInt());
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Payment method removed')));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _showEditor({Map<String, dynamic>? existing, required bool isCard}) async {
    final api = context.read<ApiBinding>();
    final label = TextEditingController(text: existing == null ? '' : '${existing['label'] ?? ''}');
    final upiCtrl = TextEditingController(text: existing != null && !isCard ? '${existing['upi_id'] ?? ''}' : '');
    final last4 = TextEditingController(text: existing != null && isCard ? '${existing['card_last4'] ?? ''}' : '');
    final network = TextEditingController(text: existing != null && isCard ? '${existing['card_network'] ?? ''}' : '');
    final holder = TextEditingController(text: existing != null && isCard ? '${existing['card_holder_name'] ?? ''}' : '');
    var isDefault = existing?['is_default'] == true || _methods.isEmpty;

    Future<void> submit(BuildContext dlgCtx) async {
      try {
        if (isCard) {
          final d4 = last4.text.replaceAll(RegExp(r'\D'), '');
          final tail = d4.length >= 4 ? d4.substring(d4.length - 4) : d4;
          final body = <String, dynamic>{
            if (label.text.trim().isNotEmpty) 'label': label.text.trim(),
            'card_last4': tail,
            if (network.text.trim().isNotEmpty) 'card_network': network.text.trim(),
            if (holder.text.trim().isNotEmpty) 'card_holder_name': holder.text.trim(),
            'is_default': isDefault,
          };
          if ('$tail'.length != 4) {
            if (dlgCtx.mounted) {
              ScaffoldMessenger.of(dlgCtx).showSnackBar(const SnackBar(content: Text('Enter the last 4 digits of your card')));
            }
            return;
          }
          if (existing != null) {
            await api.client.putProfilePaymentMethod((existing['id'] as num).toInt(), body);
          } else {
            await api.client.postProfilePaymentMethod({...body, 'method_type': 'card'});
          }
        } else {
          final upi = upiCtrl.text.trim();
          if (existing != null) {
            await api.client.putProfilePaymentMethod((existing['id'] as num).toInt(), {
              if (label.text.trim().isNotEmpty) 'label': label.text.trim(),
              'upi_id': upi,
              'is_default': isDefault,
            });
          } else {
            await api.client.postProfilePaymentMethod({
              if (label.text.trim().isNotEmpty) 'label': label.text.trim(),
              'method_type': 'upi',
              'upi_id': upi,
              'is_default': isDefault,
            });
          }
        }
        if (dlgCtx.mounted) Navigator.pop(dlgCtx);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(existing == null ? 'Saved' : 'Updated')));
        await _load();
      } catch (e) {
        if (dlgCtx.mounted) ScaffoldMessenger.of(dlgCtx).showSnackBar(SnackBar(content: Text('$e')));
      }
    }

    await showDialog<void>(
      context: context,
      builder: (dlgCtx) {
        return StatefulBuilder(
          builder: (ctx, setModal) {
            return AlertDialog(
              title: Text(existing == null
                  ? (isCard ? 'Add card reference' : 'Add UPI')
                  : (isCard ? 'Edit card reference' : 'Edit UPI')),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!isCard) ...[
                      TextField(
                        controller: upiCtrl,
                        decoration: const InputDecoration(labelText: 'UPI ID', hintText: 'name@upi'),
                      ),
                      TextField(
                        controller: label,
                        decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'Personal UPI'),
                      ),
                    ] else ...[
                      TextField(
                        controller: last4,
                        decoration: const InputDecoration(labelText: 'Last 4 digits'),
                        keyboardType: TextInputType.number,
                        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
                      ),
                      TextField(controller: network, decoration: const InputDecoration(labelText: 'Network (e.g. Visa)')),
                      TextField(controller: holder, decoration: const InputDecoration(labelText: 'Cardholder (optional)')),
                      TextField(
                        controller: label,
                        decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'Work card'),
                      ),
                    ],
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Default for checkout'),
                      value: isDefault,
                      activeThumbColor: _PayTheme.secondary,
                      onChanged: (v) => setModal(() => isDefault = v),
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(onPressed: () => Navigator.pop(dlgCtx), child: const Text('Cancel')),
                FilledButton(
                  style: FilledButton.styleFrom(backgroundColor: _PayTheme.secondary, foregroundColor: Colors.white),
                  onPressed: () => submit(dlgCtx),
                  child: const Text('Save'),
                ),
              ],
            );
          },
        );
      },
    );
  }

  Future<void> _openAddChooser() async {
    final kind = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.credit_card_rounded, color: _PayTheme.primary),
              title: const Text('Debit / credit card reference'),
              subtitle: const Text('Last 4 digits and network'),
              onTap: () => Navigator.pop(ctx, 'card'),
            ),
            ListTile(
              leading: const Icon(Icons.account_balance_wallet_rounded, color: _PayTheme.secondary),
              title: const Text('UPI ID'),
              subtitle: const Text('Save a VPA for faster pay'),
              onTap: () => Navigator.pop(ctx, 'upi'),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (kind == 'card') await _showEditor(isCard: true);
    if (kind == 'upi') await _showEditor(isCard: false);
  }

  Widget _brandMark(Map<String, dynamic> pm) {
    final net = '${pm['card_network'] ?? ''}'.toLowerCase();
    if (net.contains('visa')) {
      return const Text(
        'VISA',
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w900, fontStyle: FontStyle.italic, color: Color(0xFF1E40AF)),
      );
    }
    if (net.contains('master')) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 16,
            height: 16,
            decoration: const BoxDecoration(color: Color(0xFFEF4444), shape: BoxShape.circle),
          ),
          Transform.translate(
            offset: const Offset(-6, 0),
            child: Container(
              width: 16,
              height: 16,
              decoration: const BoxDecoration(color: Color(0xFFF59E0B), shape: BoxShape.circle),
            ),
          ),
        ],
      );
    }
    return Icon(Icons.credit_card_rounded, color: _PayTheme.onSurfaceVariant.withValues(alpha: 0.85));
  }

  Widget _glassCard(ApiBinding api, Map<String, dynamic> pm, {required bool selected}) {
    final last4 = '${pm['card_last4'] ?? '----'}';
    final isDef = pm['is_default'] == true;
    final holder = '${pm['card_holder_name'] ?? ''}'.trim();
    final subtitle = holder.isEmpty
        ? '${'${pm['card_network'] ?? ''}'.trim().isEmpty ? 'Card' : pm['card_network']} · Razorpay reference'
        : holder;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: Colors.white.withValues(alpha: 0.85),
        elevation: selected ? 0 : 1,
        shadowColor: Colors.black.withValues(alpha: 0.06),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(
            color: selected ? _PayTheme.primary : const Color(0xFF0F172A).withValues(alpha: 0.08),
            width: selected ? 2 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => setState(() => _focusedId = (pm['id'] as num?)?.toInt()),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 54,
                  height: 38,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: const Color(0xFFF1F5F9),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _PayTheme.outlineVariant),
                  ),
                  child: _brandMark(pm),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 8,
                        children: [
                          Text(
                            '•••• $last4',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: _PayTheme.onSurface),
                          ),
                          if (isDef)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(color: _PayTheme.secondaryContainer, borderRadius: BorderRadius.circular(4)),
                              child: const Text(
                                'DEFAULT',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 0.8,
                                  color: _PayTheme.onSecondaryContainer,
                                ),
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(subtitle, style: const TextStyle(fontSize: 14, height: 1.45, color: _PayTheme.onSurfaceVariant)),
                      if (!isDef)
                        TextButton(
                          style: TextButton.styleFrom(
                            padding: EdgeInsets.zero,
                            minimumSize: Size.zero,
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            foregroundColor: _PayTheme.onSecondaryContainer,
                          ),
                          onPressed: () => _setDefault(api, pm),
                          child: const Text('Set as default', style: TextStyle(fontWeight: FontWeight.w600)),
                        ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.edit_rounded),
                  color: _PayTheme.onSurfaceVariant,
                  onPressed: () => _showEditor(existing: pm, isCard: true),
                ),
                IconButton(
                  icon: const Icon(Icons.delete_outline_rounded),
                  color: _PayTheme.error,
                  onPressed: () => _confirmDelete(api, pm),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _glassUpi(ApiBinding api, Map<String, dynamic> pm) {
    final isDef = pm['is_default'] == true;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: Colors.white.withValues(alpha: 0.85),
        elevation: 1,
        shadowColor: Colors.black.withValues(alpha: 0.06),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: const Color(0xFF0F172A).withValues(alpha: 0.08)),
        ),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 54,
                height: 38,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: const Color(0xFFF2F4F6),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: _PayTheme.outlineVariant),
                ),
                child: const Icon(Icons.account_balance_wallet_rounded, color: _PayTheme.secondary),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            '${pm['upi_id'] ?? ''}',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                          ),
                        ),
                        if (isDef) ...[
                          const SizedBox(width: 8),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                            decoration: BoxDecoration(color: _PayTheme.secondaryContainer, borderRadius: BorderRadius.circular(4)),
                            child: const Text(
                              'DEFAULT',
                              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 0.8, color: _PayTheme.onSecondaryContainer),
                            ),
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    const Text('Saved VPA · Razorpay', style: TextStyle(fontSize: 14, color: _PayTheme.onSurfaceVariant)),
                    if (!isDef)
                      TextButton(
                        style: TextButton.styleFrom(
                          padding: EdgeInsets.zero,
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          foregroundColor: _PayTheme.onSecondaryContainer,
                        ),
                        onPressed: () => _setDefault(api, pm),
                        child: const Text('Set as default', style: TextStyle(fontWeight: FontWeight.w600)),
                      ),
                  ],
                ),
              ),
              IconButton(
                icon: const Icon(Icons.edit_rounded),
                color: _PayTheme.onSurfaceVariant,
                onPressed: () => _showEditor(existing: pm, isCard: false),
              ),
              IconButton(
                icon: const Icon(Icons.delete_outline_rounded),
                color: _PayTheme.error,
                onPressed: () => _confirmDelete(api, pm),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _securityBanner() => Container(
        margin: const EdgeInsets.only(bottom: 20),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: _PayTheme.secondaryContainer.withValues(alpha: 0.2),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _PayTheme.secondaryContainer.withValues(alpha: 0.55)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.verified_user_rounded, color: _PayTheme.onSecondaryContainer, size: 22),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Your payment information is encrypted and securely stored following PCI-DSS-aligned practices.',
                style: TextStyle(
                  fontSize: 14,
                  height: 1.45,
                  fontWeight: FontWeight.w500,
                  color: _PayTheme.onSecondaryContainer.withValues(alpha: 0.95),
                ),
              ),
            ),
          ],
        ),
      );

  Widget _sectionHeader(String title, [String? subtitle]) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontSize: 20, height: 1.4, fontWeight: FontWeight.w600)),
            if (subtitle != null && subtitle.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(subtitle, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: _PayTheme.onSurfaceVariant)),
              ),
          ],
        ),
      );

  Widget _walletBanner() => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(22),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [_PayTheme.primary, _PayTheme.primaryContainer],
          ),
          boxShadow: [BoxShadow(color: _PayTheme.primary.withValues(alpha: 0.35), blurRadius: 18, offset: const Offset(0, 10))],
        ),
        clipBehavior: Clip.hardEdge,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned(
              right: -36,
              bottom: -42,
              child: IgnorePointer(
                child: Container(
                  width: 120,
                  height: 120,
                  decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white.withValues(alpha: 0.12)),
                ),
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('PaxMed Wallet', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: Colors.white)),
                const SizedBox(height: 8),
                Text(
                  'Speed up pharmacy orders with a pre-loaded balance. Promotional cashback may apply on diagnostics.',
                  style: TextStyle(fontSize: 14, height: 1.45, color: Colors.white.withValues(alpha: 0.92), fontWeight: FontWeight.w500),
                ),
                const SizedBox(height: 14),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: _PayTheme.primary,
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  ),
                  onPressed: () {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Wallet signup is coming soon.')));
                  },
                  child: const Text('Activate Wallet', style: TextStyle(fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final api = context.read<ApiBinding>();

    Widget inner;
    if (!auth.isLoggedIn) {
      inner = const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('Sign in to manage payment methods.')));
    } else if (_loading) {
      inner = const Center(child: CircularProgressIndicator(color: _PayTheme.primary));
    } else if ((_err ?? '').isNotEmpty) {
      inner = Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_err!)));
    } else if (_methods.isEmpty) {
      inner = RefreshIndicator(
        color: _PayTheme.primary,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 200),
          children: [
            _securityBanner(),
            const SizedBox(height: 24),
            Text(
              'No payment methods yet',
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            const Text(
              'Add a UPI ID or save a card reference (last four digits plus network) for quicker checkout.',
              style: TextStyle(fontSize: 16, height: 1.5, color: _PayTheme.onSurfaceVariant),
            ),
            const SizedBox(height: 28),
            _walletBanner(),
          ],
        ),
      );
    } else {
      inner = RefreshIndicator(
        color: _PayTheme.primary,
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 200),
          children: [
            _securityBanner(),
            _sectionHeader('Saved cards', 'Default method is used where applicable for prescriptions and diagnostics.'),
            if (_cards.isEmpty)
              const Padding(
                padding: EdgeInsets.only(bottom: 20),
                child: Text('No card references saved yet.', style: TextStyle(color: _PayTheme.onSurfaceVariant)),
              )
            else
              for (final c in _cards) _glassCard(api, c, selected: _focusedId != null && _focusedId == (c['id'] as num).toInt()),
            const SizedBox(height: 8),
            _sectionHeader('UPI IDs'),
            if (_upis.isEmpty)
              const Padding(
                padding: EdgeInsets.only(bottom: 12),
                child: Text('No UPI IDs saved yet.', style: TextStyle(color: _PayTheme.onSurfaceVariant)),
              )
            else
              for (final u in _upis) _glassUpi(api, u),
            _walletBanner(),
          ],
        ),
      );
    }

    return Scaffold(
      backgroundColor: _PayTheme.bg,
      appBar: AppBar(
        backgroundColor: Colors.white.withValues(alpha: 0.94),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded, color: _PayTheme.primary, size: 26),
          onPressed: () => Navigator.maybeOf(context)?.pop(),
        ),
        title: const Text(
          'Payment Methods',
          style: TextStyle(fontSize: 28, height: 1.2, fontWeight: FontWeight.w700, color: _PayTheme.primary),
        ),
        actions: [
          const Padding(
            padding: EdgeInsets.only(right: 4),
            child: Icon(Icons.lock_outline_rounded, color: _PayTheme.primary, size: 24),
          ),
          PopupMenuButton<String>(
            icon: Icon(Icons.more_vert_rounded, color: Theme.of(context).colorScheme.onSurfaceVariant),
            onSelected: (v) {
              if (v == 'refresh') _load();
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'refresh', child: Text('Refresh')),
            ],
          ),
        ],
      ),
      body: Stack(
        children: [
          const Positioned.fill(child: CustomPaint(painter: _SquareGridPainter())),
          Column(children: [Expanded(child: inner)]),
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
                      _PayTheme.bg,
                      _PayTheme.bg.withValues(alpha: 0.92),
                      _PayTheme.bg.withValues(alpha: 0),
                    ],
                    stops: const [0.0, 0.42, 1.0],
                  ),
                ),
                child: Padding(
                  padding: EdgeInsets.fromLTRB(20, 26, 20, MediaQuery.paddingOf(context).bottom + 16),
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: _PayTheme.secondary,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.fromHeight(54),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      elevation: 8,
                      shadowColor: Colors.black.withValues(alpha: 0.2),
                    ),
                    onPressed: _openAddChooser,
                    icon: const Icon(Icons.add_rounded),
                    label: const Text('Add New Payment Method', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SquareGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const step = 48.0;
    final p = Paint()
      ..strokeWidth = 1
      ..color = _PayTheme.gridLine;
    var x = 0.0;
    while (x <= size.width) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), p);
      x += step;
    }
    var y = 0.0;
    while (y <= size.height) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), p);
      y += step;
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
