import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app_theme.dart';
import 'core/api_binding.dart';
import 'state/auth_state.dart';
import 'state/cart_state.dart';
import 'state/settings_state.dart';
import 'ui/home_shell.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PaxMedApp());
}

class PaxMedApp extends StatelessWidget {
  const PaxMedApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => SettingsState()..load()),
        ChangeNotifierProvider(create: (_) => CartState()..load()),
        ChangeNotifierProvider(create: (_) => AuthState()),
        ChangeNotifierProvider(
          create: (cx) {
            final b = ApiBinding(cx.read<SettingsState>());
            Future.microtask(() => b.initAndRefreshAuth(cx.read<AuthState>()));
            return b;
          },
        ),
      ],
      child: MaterialApp(
        title: 'PaxMed',
        theme: AppTheme.light(),
        home: const ApiBootstrapGate(),
      ),
    );
  }
}
