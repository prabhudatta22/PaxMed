import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsState extends ChangeNotifier {
  static const _kBaseUrl = 'paxmed_api_base_url';

  /// Defaults:
  /// - Android emulator: http://10.0.2.2:3000
  /// - iOS simulator: http://localhost:3000
  /// - device (same Wi‑Fi): http://<your-lan-ip>:3000
  String _baseUrl = 'http://10.0.2.2:3000';

  String get baseUrl => _baseUrl;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _baseUrl = prefs.getString(_kBaseUrl) ?? _baseUrl;
    notifyListeners();
  }

  Future<void> setBaseUrl(String v) async {
    final next = v.trim();
    if (next.isEmpty) return;
    _baseUrl = next;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kBaseUrl, next);
  }
}

