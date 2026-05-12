import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../api/client.dart';
import '../state/auth_state.dart';
import '../state/settings_state.dart';

String normalizeBaseUrl(String raw) {
  final t = raw.trim();
  if (t.isEmpty) return 'http://10.0.2.2:3000';
  return t.endsWith('/') ? t.substring(0, t.length - 1) : t;
}

class ApiBinding extends ChangeNotifier {
  ApiBinding(this.settings) {
    settings.addListener(_onSettingsChanged);
  }

  final SettingsState settings;

  Dio? _dio;
  PersistCookieJar? _jar;
  PaxMedClient? _client;
  bool ready = false;
  String? initError;

  PaxMedClient get client {
    final c = _client;
    if (c == null) {
      throw StateError('ApiBinding not ready');
    }
    return c;
  }

  Future<void> initAndRefreshAuth(AuthState auth) async {
    try {
      await _ensureDio();
      ready = true;
      initError = null;
      notifyListeners();
      await auth.refresh(this);
    } catch (e) {
      initError = e.toString();
      ready = true;
      notifyListeners();
    }
  }

  void _onSettingsChanged() {
    final d = _dio;
    if (d == null) return;
    d.options.baseUrl = normalizeBaseUrl(settings.baseUrl);
    notifyListeners();
  }

  Future<void> _ensureDio() async {
    final dir = await getApplicationDocumentsDirectory();
    _jar = PersistCookieJar(storage: FileStorage('${dir.path}/.ml_cookies'));
    final base = normalizeBaseUrl(settings.baseUrl);
    _dio = Dio(
      BaseOptions(
        baseUrl: base,
        validateStatus: (_) => true,
        headers: const {'Accept': 'application/json'},
        connectTimeout: const Duration(seconds: 45),
        receiveTimeout: const Duration(seconds: 45),
      ),
    );
    _dio!.interceptors.add(CookieManager(_jar!));
    _client = PaxMedClient(_dio!);
  }

  Future<void> clearSessionCookies() async {
    final j = _jar;
    if (j == null) return;
    final u = Uri.parse(normalizeBaseUrl(settings.baseUrl));
    await j.delete(u, true);
  }

  @override
  void dispose() {
    settings.removeListener(_onSettingsChanged);
    super.dispose();
  }
}
