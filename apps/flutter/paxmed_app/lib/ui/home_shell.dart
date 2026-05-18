import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../app_theme.dart';
import '../core/api_binding.dart';
import '../state/auth_state.dart';
import '../state/cart_state.dart';
import 'cart_screen.dart';
import 'labs_screen.dart';
import 'orders_screen.dart';
import 'profile_screen.dart';
import 'search_screen.dart';
import 'settings_sheet.dart';

class _ShellAppBarTitle extends StatelessWidget {
  const _ShellAppBarTitle({required this.tab});

  final int tab;

  static const _subtitles = [
    'Compare medicine prices',
    'Diagnostics · lab tests',
    'Your cart',
    'Order history',
    'Your profile',
  ];

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    final sub = _subtitles[tab.clamp(0, _subtitles.length - 1)];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) => const LinearGradient(
            colors: [PaxMedColors.primary, PaxMedColors.secondary],
          ).createShader(Rect.fromLTWH(0, 0, bounds.width > 1 ? bounds.width : 120, 28)),
          child: const Text(
            'PaxMed',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w800,
              color: Colors.white,
              height: 1.05,
              letterSpacing: -0.35,
            ),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          sub,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: t.textTheme.labelSmall?.copyWith(
            color: t.colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );
  }
}

class PaxMedShell extends StatefulWidget {
  const PaxMedShell({super.key});

  @override
  State<PaxMedShell> createState() => _PaxMedShellState();
}

class _PaxMedShellState extends State<PaxMedShell> {
  int _tab = 0;

  Future<void> _openSettings(BuildContext cx) async {
    await showModalBottomSheet<void>(
      context: cx,
      isScrollControlled: true,
      builder: (_) => const SettingsSheet(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();

    return Scaffold(
      appBar: AppBar(
        title: _ShellAppBarTitle(tab: _tab),
        actions: [
          IconButton(onPressed: () => _openSettings(context), icon: const Icon(Icons.settings)),
          Badge(
            isLabelVisible: cart.totalQty > 0,
            label: Text('${cart.totalQty}'),
            child: IconButton(
              tooltip: 'Cart',
              icon: const Icon(Icons.shopping_cart_outlined),
              onPressed: () => setState(() => _tab = 2),
            ),
          ),
        ],
      ),
      body: IndexedStack(
        index: _tab,
        children: const [
          SearchScreen(embedded: true),
          LabsScreen(embedded: true),
          CartScreen(embedded: true),
          OrdersScreen(),
          ProfileScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.search), label: 'Meds'),
          NavigationDestination(icon: Icon(Icons.biotech_outlined), label: 'Labs'),
          NavigationDestination(icon: Icon(Icons.shopping_cart_outlined), label: 'Cart'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), label: 'Orders'),
          NavigationDestination(icon: Icon(Icons.person_outline), label: 'Profile'),
        ],
      ),
    );
  }
}

class ApiBootstrapGate extends StatelessWidget {
  const ApiBootstrapGate({super.key});

  @override
  Widget build(BuildContext context) {
    final api = context.watch<ApiBinding>();
    if (!api.ready) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final err = api.initError;
    if ((err ?? '').trim().isNotEmpty) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Networking init issue:\n$err'),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () {
                    api.initAndRefreshAuth(context.read<AuthState>());
                  },
                  child: const Text('Retry'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    return const PaxMedShell();
  }
}
