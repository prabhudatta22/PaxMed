import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';
import 'login_screen.dart';
import 'order_detail_screen.dart';

/// Stitch “PaxMed — Order History” palette (tailwind theme excerpt).
abstract final class _OrdersTheme {
  static const surface = Color(0xFFF7F9FB);
  static const surfaceWhite = Color(0xFFFFFFFF);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const primary = Color(0xFF006194);
  static const primaryContainer = Color(0xFF007BB9);
  static const secondary = Color(0xFF006B5F);
  static const secondaryContainerTint = Color(0x336DF5E1);
  static const primaryContainerTint = Color(0x1A007BB9);
  static const tealLight = Color(0xFF2DD4BF);
  static const tealDarkBanner = Color(0xFF0C2451);
  static const successGreen = Color(0xFF16A34A);
  static const warningAmber = Color(0xFFD97706);

  /// ~rgba(0, 97, 148, 0.03) on light surface.
  static const gridLine = Color(0x08006194);
}

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

enum _OrderFilterMode { all, pharmacy, labs }

class _OrdersScreenState extends State<OrdersScreen> {
  List<Map<String, dynamic>> _rows = [];
  String? _err;
  bool _loading = false;
  bool _medicineExpanded = true;
  bool _labExpanded = true;
  String _query = '';
  _OrderFilterMode _filterMode = _OrderFilterMode.all;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => load());
  }

  Future<void> load() async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) return;
    setState(() {
      _loading = true;
      _err = null;
    });
    try {
      final r = await context.read<ApiBinding>().client.listOrders();
      final list = r['orders'] as List<dynamic>? ?? [];
      _rows = list.map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (e) {
      _err = e.toString();
    }
    setState(() => _loading = false);
  }

  static String _fmtSubtitleDate(dynamic iso) {
    try {
      final d = DateTime.parse(iso.toString()).toLocal();
      return DateFormat('d MMM y').format(d);
    } catch (_) {
      return iso?.toString() ?? '';
    }
  }

  bool _isDiagnostics(Map<String, dynamic> o) =>
      '${o['order_kind']}'.toLowerCase() == 'diagnostics';

  String _displayTitle(Map<String, dynamic> o) {
    final label = '${o['primary_item_label'] ?? ''}'.trim();
    if (label.isNotEmpty) return label;
    if (_isDiagnostics(o)) {
      final notes = '${o['notes'] ?? ''}'.trim();
      if (notes.isNotEmpty) {
        final first = notes.split(RegExp(r'[\r\n]+')).first.trim();
        if (first.length > 56) return '${first.substring(0, 53)}…';
        return first;
      }
      return 'Lab diagnostics';
    }
    return 'Medicine order';
  }

  double _totalInr(Map<String, dynamic> o) {
    final itemsSum = double.tryParse('${o['items_total_inr'] ?? 0}') ?? 0;
    final fee = double.tryParse('${o['delivery_fee_inr'] ?? 0}') ?? 0;
    final t = itemsSum + fee;
    return t >= 0 ? t : fee;
  }

  String _formattedTotal(Map<String, dynamic> o) {
    final n = _totalInr(o);
    if (n == 0) return '₹—';
    return NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 2).format(n);
  }

  void _openOrder(int id) {
    Navigator.of(context)
        .push(
          MaterialPageRoute<void>(
            builder: (_) => OrderDetailScreen(orderId: id),
          ),
        )
        .then((_) => load());
  }

  void _toast(String msg) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  }

  bool _matchesQuery(Map<String, dynamic> o) {
    if (_query.trim().isEmpty) return true;
    final raw = _query.trim().toLowerCase();
    final compact = raw.replaceAll(RegExp(r'\s+'), '');
    final id = (o['id'] as num?)?.toInt();
    final idMatch = id != null &&
        (raw == '$id' || compact.endsWith('$id'.toLowerCase()) || compact.contains('$id') || raw.contains('$id'));
    return idMatch ||
        '${o['primary_item_label'] ?? ''}'.toLowerCase().contains(raw) ||
        _displayTitle(o).toLowerCase().contains(raw) ||
        '${o['notes'] ?? ''}'.toLowerCase().contains(raw);
  }

  List<Map<String, dynamic>> get _medicineRows {
    var xs = _rows.where((o) => !_isDiagnostics(o)).where(_matchesQuery).toList();
    if (_filterMode == _OrderFilterMode.labs) return [];
    return xs;
  }

  List<Map<String, dynamic>> get _labRows {
    var xs = _rows.where((o) => _isDiagnostics(o)).where(_matchesQuery).toList();
    if (_filterMode == _OrderFilterMode.pharmacy) return [];
    return xs;
  }

  Future<void> _showSearchSheet() async {
    final ctrl = TextEditingController(text: _query);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(20, 8, 20, MediaQuery.paddingOf(ctx).bottom + 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Search orders', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
            const SizedBox(height: 12),
            TextField(
              controller: ctrl,
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'Order title or #PX-123',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (_) {
                setState(() => _query = ctrl.text.trim());
                Navigator.pop(ctx);
              },
            ),
            const SizedBox(height: 14),
            FilledButton(
              onPressed: () {
                setState(() => _query = ctrl.text.trim());
                Navigator.pop(ctx);
              },
              child: const Text('Apply'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _showFilterSheet() async {
    var sel = _filterMode;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (_, setModal) {
            return Padding(
              padding: EdgeInsets.fromLTRB(20, 8, 20, MediaQuery.paddingOf(ctx).bottom + 20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Filter', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 16),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final mode in _OrderFilterMode.values)
                        ChoiceChip(
                          label: Text(switch (mode) {
                            _OrderFilterMode.all => 'All',
                            _OrderFilterMode.pharmacy => 'Medicine only',
                            _OrderFilterMode.labs => 'Lab tests only',
                          }),
                          selected: sel == mode,
                          onSelected: (_) => setModal(() => sel = mode),
                        ),
                    ],
                  ),
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: () {
                      setState(() => _filterMode = sel);
                      Navigator.pop(ctx);
                    },
                    child: const Text('Done'),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  ({String label, Color bg, Color fg}) _statusChip(Map<String, dynamic> o) {
    switch ('${o['status']}'.toLowerCase()) {
      case 'delivered':
        if (_isDiagnostics(o)) {
          return (
            label: 'Completed',
            bg: _OrdersTheme.primaryContainer.withValues(alpha: 0.1),
            fg: _OrdersTheme.primaryContainer,
          );
        }
        return (
          label: 'Delivered',
          bg: _OrdersTheme.successGreen.withValues(alpha: 0.1),
          fg: _OrdersTheme.successGreen,
        );
      case 'out_for_delivery':
        return (
          label: 'Out for Delivery',
          bg: _OrdersTheme.warningAmber.withValues(alpha: 0.1),
          fg: _OrdersTheme.warningAmber,
        );
      case 'cancelled':
        return (
          label: 'Cancelled',
          bg: _OrdersTheme.outline.withValues(alpha: 0.12),
          fg: _OrdersTheme.outline,
        );
      case 'confirmed':
      case 'packed':
        return (
          label: _isDiagnostics(o) ? 'Confirmed' : 'Processing',
          bg: _OrdersTheme.primaryContainer.withValues(alpha: 0.1),
          fg: _OrdersTheme.primaryContainer,
        );
      case 'created':
      default:
        return (
          label: 'Processing',
          bg: _OrdersTheme.outlineVariant.withValues(alpha: 0.35),
          fg: _OrdersTheme.outline,
        );
    }
  }

  Widget _stickyTopBar(BuildContext context) => Material(
        color: Colors.white.withValues(alpha: 0.94),
        child: SizedBox(
          height: kToolbarHeight,
          child: Row(
            children: [
              IconButton(
                onPressed: () => Navigator.maybeOf(context)?.pop(),
                icon: const Icon(Icons.arrow_back_rounded),
                style: IconButton.styleFrom(
                  foregroundColor: _OrdersTheme.primary,
                ),
              ),
              Expanded(
                child: Text(
                  'Order History${_query.isNotEmpty ? ' · filtered' : ''}',
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    height: 1.35,
                    color: _OrdersTheme.primary,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                onPressed: _showSearchSheet,
                icon: Icon(Icons.search_rounded, color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
              IconButton(
                onPressed: _showFilterSheet,
                icon: Icon(Icons.filter_list_rounded, color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      );

  Widget _goldBanner() => Container(
        margin: const EdgeInsets.symmetric(vertical: 28),
        padding: const EdgeInsets.fromLTRB(24, 22, 24, 22),
        decoration: BoxDecoration(
          color: _OrdersTheme.tealDarkBanner,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.22),
              blurRadius: 20,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned(
              right: -20,
              bottom: -20,
              child: Icon(
                Icons.verified_rounded,
                size: 140,
                color: Colors.white.withValues(alpha: 0.06),
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'PREMIUM CARE',
                  style: TextStyle(
                    fontSize: 11,
                    letterSpacing: 1.8,
                    fontWeight: FontWeight.w700,
                    color: _OrdersTheme.tealLight.withValues(alpha: 0.95),
                  ),
                ),
                const SizedBox(height: 10),
                const Text(
                  'PaxMed Gold',
                  style: TextStyle(
                    fontSize: 26,
                    height: 1.15,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  'Get unlimited free delivery and 15% off on all diagnostic tests.',
                  style: TextStyle(fontSize: 14, height: 1.45, color: Colors.white.withValues(alpha: 0.82)),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: _OrdersTheme.secondary,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  onPressed: () => _toast('Upgrade coming soon'),
                  child: const Text('Upgrade Now', style: TextStyle(fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          ],
        ),
      );

  Widget _buildOrderTile(Map<String, dynamic> o) {
    final id = (o['id'] as num).toInt();
    final diagnostics = _isDiagnostics(o);
    final st = _statusChip(o);
    final dateLine = '#PX-$id • ${_fmtSubtitleDate(o['created_at'] ?? o['scheduled_for'])}';

    Widget leadingIcon() {
      if (diagnostics) {
        return Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            color: _OrdersTheme.primaryContainerTint,
          ),
          child: const Icon(Icons.biotech_rounded, color: _OrdersTheme.primary, size: 26),
        );
      }
      return Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          color: _OrdersTheme.secondaryContainerTint,
        ),
        child: const Icon(Icons.medical_services_rounded, color: _OrdersTheme.secondary, size: 26),
      );
    }

    Widget actionRow(String statusNorm) {
      if (diagnostics) {
        if (statusNorm == 'delivered') {
          return FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: _OrdersTheme.primary,
              foregroundColor: Colors.white,
              elevation: 0,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              minimumSize: const Size(0, 40),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            ),
            onPressed: () => _openOrder(id),
            child: const Text('View Report', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          );
        }
        if (statusNorm == 'out_for_delivery') {
          return IconButton(
            style: IconButton.styleFrom(
              foregroundColor: _OrdersTheme.outline,
              side: const BorderSide(color: _OrdersTheme.outlineVariant),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              padding: const EdgeInsets.all(10),
            ),
            onPressed: () => _openOrder(id),
            icon: const Icon(Icons.local_shipping_outlined, size: 22),
          );
        }
        return FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: _OrdersTheme.primary,
            foregroundColor: Colors.white,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            minimumSize: const Size(0, 40),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          onPressed: () => _openOrder(id),
          child: const Text('Details', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
        );
      }

      final reorder = OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: _OrdersTheme.tealLight,
          side: const BorderSide(color: _OrdersTheme.tealLight, width: 2),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          minimumSize: const Size(0, 40),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
        onPressed: () => _toast('Reorder coming soon'),
        child: const Text('Reorder', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
      );

      if (statusNorm == 'out_for_delivery') {
        return IconButton(
          style: IconButton.styleFrom(
            foregroundColor: _OrdersTheme.outline,
            side: const BorderSide(color: _OrdersTheme.outlineVariant),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
            padding: const EdgeInsets.all(10),
          ),
          onPressed: () => _openOrder(id),
          icon: const Icon(Icons.local_shipping_outlined, size: 22),
        );
      }
      return reorder;
    }

    final statusNorm = '${o['status']}'.toLowerCase();

    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Material(
        color: _OrdersTheme.surfaceWhite,
        borderRadius: BorderRadius.circular(14),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => _openOrder(id),
          splashColor: _OrdersTheme.primary.withValues(alpha: 0.06),
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: _OrdersTheme.outlineVariant.withValues(alpha: 0.35)),
              boxShadow: [
                BoxShadow(
                  color: const Color(0xFF12202F).withValues(alpha: 0.04),
                  blurRadius: 12,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      leadingIcon(),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              _displayTitle(o),
                              style: const TextStyle(fontSize: 16, height: 1.25, fontWeight: FontWeight.w600),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              dateLine,
                              style: const TextStyle(fontSize: 14, height: 1.45, color: _OrdersTheme.outline, fontWeight: FontWeight.w500),
                            ),
                          ],
                        ),
                      ),
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: st.bg,
                          borderRadius: BorderRadius.circular(999),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          child: Text(
                            st.label,
                            style: TextStyle(fontSize: 11, letterSpacing: 0.35, height: 1.2, fontWeight: FontWeight.w700, color: st.fg),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const Divider(height: 26, thickness: 0.7, color: Color(0x12BFC7D2)),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'TOTAL AMOUNT',
                            style: TextStyle(
                              fontSize: 11,
                              letterSpacing: 1.35,
                              fontWeight: FontWeight.w700,
                              height: 1.25,
                              color: _OrdersTheme.outline,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _formattedTotal(o),
                            style: const TextStyle(
                              fontSize: 17,
                              height: 1,
                              letterSpacing: -0.2,
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ],
                      ),
                      actionRow(statusNorm),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _accordionHeader({
    required String title,
    required IconData icon,
    required bool expanded,
    required VoidCallback onTap,
  }) =>
      Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Row(
                    children: [
                      Icon(icon, color: _OrdersTheme.primary, size: 24),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          title,
                          style: const TextStyle(
                            fontSize: 18,
                            height: 1.35,
                            fontWeight: FontWeight.w600,
                            color: _OrdersTheme.primary,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                ),
                AnimatedRotation(
                  turns: expanded ? 0 : -0.25,
                  duration: const Duration(milliseconds: 280),
                  curve: Curves.easeInOutCubic,
                  child: const Icon(Icons.expand_more_rounded, color: _OrdersTheme.primary, size: 28),
                ),
              ],
            ),
          ),
        ),
      );

  Widget _expandableOrderList(bool expanded, List<Map<String, dynamic>> rows, {required String emptyHint}) =>
      AnimatedSize(
        duration: const Duration(milliseconds: 280),
        curve: Curves.easeInOutCubic,
        alignment: Alignment.topCenter,
        child: expanded
            ? Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (rows.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          emptyHint,
                          style: const TextStyle(
                            fontSize: 14,
                            height: 1.45,
                            fontWeight: FontWeight.w500,
                            color: _OrdersTheme.outline,
                          ),
                        ),
                      )
                    else
                      for (final o in rows) _buildOrderTile(o),
                  ],
                ),
              )
            : const SizedBox(width: double.infinity),
      );

  Widget _accordionBody() => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _accordionHeader(
            title: 'Medicine Orders',
            icon: Icons.medical_services_rounded,
            expanded: _medicineExpanded,
            onTap: () => setState(() => _medicineExpanded = !_medicineExpanded),
          ),
          _expandableOrderList(
            _medicineExpanded,
            _medicineRows,
            emptyHint: switch (_filterMode) {
              _OrderFilterMode.labs => 'Showing lab tests only. Change filter to see medicine orders.',
              _ => (_query.trim().isNotEmpty ? 'No medicine orders match your search.' : 'No medicine orders yet.'),
            },
          ),
          _goldBanner(),
          _accordionHeader(
            title: 'Lab Test Orders',
            icon: Icons.biotech_rounded,
            expanded: _labExpanded,
            onTap: () => setState(() => _labExpanded = !_labExpanded),
          ),
          _expandableOrderList(
            _labExpanded,
            _labRows,
            emptyHint: switch (_filterMode) {
              _OrderFilterMode.pharmacy => 'Showing medicine orders only. Change filter to see lab tests.',
              _ => (_query.trim().isNotEmpty ? 'No lab orders match your search.' : 'No lab test orders yet.'),
            },
          ),
          TextButton.icon(
            onPressed: () => _toast('Older orders pagination is coming soon'),
            icon: const Icon(Icons.expand_more_rounded, size: 20, color: _OrdersTheme.primary),
            label: const Text('Show older orders', style: TextStyle(color: _OrdersTheme.primary, fontWeight: FontWeight.w600)),
          ),
          const SizedBox(height: 120),
        ],
      );

  Widget _wrappedBody(AuthState auth) => Stack(
        children: [
          Positioned.fill(child: CustomPaint(painter: _OrderHistoryGridPainter())),
          RefreshIndicator(
            color: _OrdersTheme.primary,
            onRefresh: load,
            displacement: widget.embedded ? 24 : 8,
            child: CustomScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              slivers: [
                if (!auth.isLoggedIn)
                  SliverFillRemaining(
                    hasScrollBody: false,
                    child: Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text('Sign in to fetch your backend orders.'),
                            const SizedBox(height: 14),
                            Builder(
                              builder: (cx) => FilledButton(
                                onPressed: () =>
                                    Navigator.of(cx).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen())),
                                child: const Text('Login'),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  )
                else if (_loading)
                  const SliverFillRemaining(
                    hasScrollBody: false,
                    child: Center(child: CircularProgressIndicator(color: _OrdersTheme.primary)),
                  )
                else if ((_err ?? '').trim().isNotEmpty)
                  SliverFillRemaining(
                    hasScrollBody: false,
                    child: Center(child: Padding(padding: const EdgeInsets.all(16), child: Text(_err!))),
                  )
                else
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
                    sliver: SliverToBoxAdapter(
                      child: _accordionBody(),
                    ),
                  ),
              ],
            ),
          ),
        ],
      );

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final body = ColoredBox(
      color: _OrdersTheme.surface,
      child: _wrappedBody(auth),
    );

    if (widget.embedded) return body;

    return Scaffold(
      backgroundColor: _OrdersTheme.surface,
      appBar: PreferredSize(
        preferredSize: const Size.fromHeight(kToolbarHeight),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.94),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.04),
                blurRadius: 8,
                offset: const Offset(0, 1),
              ),
            ],
          ),
          child: SafeArea(bottom: false, child: _stickyTopBar(context)),
        ),
      ),
      body: body,
    );
  }
}

/// Light teal grid backdrop (Stitch Tailwind gradient lines).
class _OrderHistoryGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const step = 48.0;
    final p = Paint()
      ..color = _OrdersTheme.gridLine
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
