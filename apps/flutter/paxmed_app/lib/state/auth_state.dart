import 'package:flutter/foundation.dart';

import '../core/api_binding.dart';

class AuthState extends ChangeNotifier {
  Map<String, dynamic>? user;

  bool get isLoggedIn => user != null && user!['role'] != 'service_provider';

  String? get phoneE164 => user?['phone_e164']?.toString();

  Future<void> refresh(ApiBinding api) async {
    try {
      final me = await api.client.getAuthMe();
      final u = me['user'];
      if (u is Map<String, dynamic>) {
        user = u;
      } else {
        user = null;
      }
    } catch (_) {
      user = null;
    }
    notifyListeners();
  }

  Future<void> signOut(ApiBinding api) async {
    try {
      await api.client.postAuthLogout();
    } catch (_) {
      /* ignore */
    }
    await api.clearSessionCookies();
    user = null;
    notifyListeners();
  }

  void setUser(Map<String, dynamic>? u) {
    user = u;
    notifyListeners();
  }
}
