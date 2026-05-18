import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SettingsState extends ChangeNotifier {
  static const _kBaseUrl = 'paxmed_api_base_url';

  static String _platformDefaultBaseUrl() {
    if (kIsWeb) {
      final h = Uri.base.host.trim();
      final host = h.isEmpty ? 'localhost' : h;
      return 'http://$host:3000';
    }
    return 'http://10.0.2.2:3000';
  }

  /// Defaults:
  /// - Web (Chrome): http://<same-host>:3000 (e.g. localhost or 127.0.0.1).
  /// - Android emulator: http://10.0.2.2:3000
  /// - iOS simulator / physical device: set via Settings or same LAN IP.
  String _baseUrl = _platformDefaultBaseUrl();

  String get baseUrl => _baseUrl;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_kBaseUrl)?.trim();
    if (saved == null || saved.isEmpty) {
      _baseUrl = _platformDefaultBaseUrl();
    } else if (kIsWeb && saved.contains('10.0.2.2')) {
      // Emulator-only host is unreachable from a browser build.
      _baseUrl = _platformDefaultBaseUrl();
      await prefs.setString(_kBaseUrl, _baseUrl);
    } else {
      _baseUrl = saved;
    }
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

