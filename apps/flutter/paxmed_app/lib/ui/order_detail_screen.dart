import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';

class OrderDetailScreen extends StatefulWidget {
  const OrderDetailScreen({super.key, required this.orderId});

  final int orderId;

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  Map<String, dynamic>? _data;
  String? _err;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final auth = context.read<AuthState>();
    if (!auth.isLoggedIn) return;
    setState(() => _loading = true);
    try {
      final r = await context.read<ApiBinding>().client.getOrderDetail(widget.orderId);
      _data = r;
      _err = null;
    } catch (e) {
      _err = e.toString();
      _data = null;
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final d = _data;
    final orderRaw = d?['order'];
    final ord = orderRaw is Map<String, dynamic> ? orderRaw : null;
    final items =
        (d?['items'] as List<dynamic>? ?? []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final eventsRaw =
        (d?['events'] as List<dynamic>? ?? []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

    return Scaffold(
      appBar: AppBar(title: Text('Order #${widget.orderId}')),
      floatingActionButton: ord == null
          ? null
          : FloatingActionButton.small(onPressed: _load, child: const Icon(Icons.refresh)),
      body: !auth.isLoggedIn
          ? const Center(child: Text('Login required'))
          : _loading
              ? const Center(child: CircularProgressIndicator())
              : _err != null
                  ? Center(child: Padding(padding: const EdgeInsets.all(16), child: Text(_err!)))
                  : ord == null
                      ? const Center(child: Text('No data'))
                      : ListView(
                          padding: const EdgeInsets.all(16),
                          children: [
                            ListTile(title: Text('Status: ${ord['status']}'), subtitle: Text('Kind: ${ord['order_kind']}')),
                            if (ord['payment_status'] != null) ListTile(title: Text('Payment: ${ord['payment_status']}')),
                            if (ord['provider_order_ref'] != null)
                              ListTile(title: const Text('Partner ref'), subtitle: Text('${ord['provider_order_ref']}')),
                            const Divider(height: 24),
                            const Text('Items', style: TextStyle(fontWeight: FontWeight.w700)),
                            ...items.map(
                              (it) => ListTile(
                                title: Text('${it['item_label']}'),
                                subtitle: Text(
                                  'qty ${it['quantity_units']} × ₹${it['unit_price_inr']}',
                                ),
                              ),
                            ),
                            const Divider(height: 24),
                            const Text('Events', style: TextStyle(fontWeight: FontWeight.w700)),
                            ...eventsRaw.map(
                              (e) => ListTile(
                                dense: true,
                                title: Text(e['status']?.toString() ?? ''),
                                subtitle: Text(e['created_at']?.toString() ?? ''),
                              ),
                            ),
                          ],
                        ),
    );
  }
}
