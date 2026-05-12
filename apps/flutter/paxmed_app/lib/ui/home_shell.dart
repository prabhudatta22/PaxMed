import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';
import '../state/cart_state.dart';
import 'cart_screen.dart';
import 'labs_screen.dart';
import 'orders_screen.dart';
import 'profile_screen.dart';
import 'search_screen.dart';
import 'settings_sheet.dart';

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

  static const _titles = ['Medicines', 'Labs', 'Cart', 'Orders', 'Profile'];

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();

    return Scaffold(
      appBar: AppBar(
        title: Text('PaxMed · ${_titles[_tab]}'),
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
