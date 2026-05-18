import 'package:flutter/material.dart';

/// PaxMed UI tokens — aligned with `public/theme-vars.css` (web).
abstract final class PaxMedColors {
  static const primary = Color(0xFF0284C7);
  static const secondary = Color(0xFF14B8A6);
  static const labsAccent = Color(0xFF0891B2);
  static const cartPrimary = Color(0xFF9333EA);
  static const cartSecondary = Color(0xFFEC4899);
  static const reminder = Color(0xFFD97706);
  static const orders = Color(0xFF4F46E5);
  static const profile = Color(0xFF0D7A6C);
  static const surface = Color(0xFFFFFFFF);
  static const scaffoldBg = Color(0xFFF8FAFC);
  static const inputFill = Color(0xFFF3F4F6);
  static const border = Color(0x1A0F172A);
}

class AppTheme {
  static ThemeData light() {
    final cs = ColorScheme.fromSeed(
      seedColor: PaxMedColors.primary,
      primary: PaxMedColors.primary,
      secondary: PaxMedColors.secondary,
      surface: PaxMedColors.surface,
      brightness: Brightness.light,
    );

    final outline = Color.lerp(cs.outline, const Color(0xFF0F172A), 0.35)!;

    return ThemeData(
      colorScheme: cs,
      useMaterial3: true,
      scaffoldBackgroundColor: PaxMedColors.scaffoldBg,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.white.withValues(alpha: 0.94),
        foregroundColor: cs.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.black.withValues(alpha: 0.06),
        titleSpacing: 16,
        titleTextStyle: TextStyle(
          fontWeight: FontWeight.w800,
          fontSize: 18,
          letterSpacing: -0.3,
          color: cs.onSurface,
        ),
      ),
      cardTheme: CardThemeData(
        color: PaxMedColors.surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: outline.withValues(alpha: 0.55)),
        ),
        shadowColor: Colors.black.withValues(alpha: 0.07),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 68,
        elevation: 0,
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        indicatorColor: PaxMedColors.primary.withValues(alpha: 0.12),
        labelTextStyle: WidgetStateProperty.resolveWith((s) {
          const small = TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600);
          if (s.contains(WidgetState.selected)) {
            return small.copyWith(color: PaxMedColors.primary);
          }
          return small.copyWith(color: cs.onSurfaceVariant);
        }),
        iconTheme: WidgetStateProperty.resolveWith((s) {
          if (s.contains(WidgetState.selected)) {
            return const IconThemeData(color: PaxMedColors.primary, size: 24);
          }
          return IconThemeData(color: cs.onSurfaceVariant, size: 24);
        }),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          backgroundColor: PaxMedColors.primary,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          shadowColor: PaxMedColors.primary.withValues(alpha: 0.28),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          side: BorderSide(color: outline.withValues(alpha: 0.45)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: PaxMedColors.inputFill,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: outline.withValues(alpha: 0.5), width: 2),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: outline.withValues(alpha: 0.45), width: 2),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: PaxMedColors.primary.withValues(alpha: 0.75), width: 2),
        ),
      ),
      chipTheme: ChipThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        side: BorderSide(color: outline.withValues(alpha: 0.35)),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      ),
      dividerTheme: DividerThemeData(color: outline.withValues(alpha: 0.35)),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }
}
