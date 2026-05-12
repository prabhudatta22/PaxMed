import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';
import 'login_screen.dart';
import 'order_detail_screen.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  List<Map<String, dynamic>> _rows = [];
  String? _err;
  bool _loading = false;

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

  static String fmtDt(dynamic iso) {
    try {
      final d = DateTime.parse(iso.toString()).toLocal();
      return DateFormat.yMMMd().add_jm().format(d);
    } catch (_) {
      return iso?.toString() ?? '';
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Orders'),
        actions: [
          IconButton(onPressed: load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: !auth.isLoggedIn
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  children: [
                    const Text('Sign in to fetch your backend orders.'),
                    const SizedBox(height: 14),
                    FilledButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen())), child: const Text('Login')),
                  ],
                ),
              ),
            )
          : _loading
              ? const Center(child: CircularProgressIndicator())
              : ((_err ?? '').trim().isNotEmpty)
                  ? Center(child: Padding(padding: const EdgeInsets.all(16), child: Text(_err!)))
                  : _rows.isEmpty
                      ? const Center(child: Text('No backend orders yet.'))
                      : ListView.separated(
                          padding: const EdgeInsets.all(12),
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemCount: _rows.length,
                          itemBuilder: (_, i) {
                            final o = _rows[i];
                            final id = (o['id'] as num).toInt();
                            return ListTile(
                              title: Text('#$id • ${o['order_kind'] ?? 'medicine'}'),
                              subtitle: Text('${o['status']} · ${fmtDt(o['created_at'] ?? o['scheduled_for'])}'),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () {
                                Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => OrderDetailScreen(orderId: id),
                                  ),
                                ).then((_) => load());
                              },
                            );
                          },
                        ),
    );
  }
}
