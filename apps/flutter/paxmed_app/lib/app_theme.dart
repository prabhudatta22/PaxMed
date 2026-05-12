import 'package:flutter/material.dart';

class AppTheme {
  static ThemeData light() {
    const seed = Color(0xFF0D7A6C);
    final cs = ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.light);
    return ThemeData(
      colorScheme: cs,
      useMaterial3: true,
      scaffoldBackgroundColor: const Color(0xFFEEF2F7),
      appBarTheme: AppBarTheme(
        backgroundColor: const Color(0xFFEEF2F7),
        foregroundColor: cs.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      cardTheme: CardTheme(
        color: Colors.white,
        elevation: 0,
        margin: const EdgeInsets.all(0),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: Color(0xFFD0DAE6)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFD0DAE6)),
        ),
      ),
    );
  }
}

