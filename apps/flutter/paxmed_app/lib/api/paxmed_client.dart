import 'package:dio/dio.dart';

import 'models.dart';

class PaxMedClient {
  PaxMedClient(this.dio);

  final Dio dio;

  Map<String, dynamic> _m(dynamic data) {
    if (data is Map<String, dynamic>) return data;
    if (data is Map) return Map<String, dynamic>.from(data);
    return {};
  }

  void _ensure2xx(Response r) {
    final c = r.statusCode ?? 599;
    if (c >= 400) {
      throw Exception(_m(r.data)['error']?.toString() ?? 'Request failed ($c)');
    }
  }

  // --- Session & auth ---
  Future<Map<String, dynamic>> getAuthMe() async {
    final r = await dio.get('/api/auth/me');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postAuthRequestOtp(String phoneDigits) async {
    final r = await dio.post('/api/auth/request-otp', data: {'phone': phoneDigits});
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postAuthVerifyOtp({required String phoneDigits, required String code}) async {
    final r = await dio.post('/api/auth/verify-otp', data: {'phone': phoneDigits, 'code': code});
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postAuthLogout() async {
    final r = await dio.post('/api/auth/logout');
    _ensure2xx(r);
    return _m(r.data);
  }

  // --- Public catalog ---
  Future<List<City>> getCities() async {
    final r = await dio.get('/api/cities');
    _ensure2xx(r);
    final list = (_m(r.data)['cities'] as List<dynamic>? ?? []);
    return list.map((x) => City.fromJson(x as Map<String, dynamic>)).toList();
  }

  Future<List<LocalOffer>> searchLocal({
    required String q,
    required String citySlug,
    double? lat,
    double? lng,
  }) async {
    final r = await dio.get(
      '/api/compare/search',
      queryParameters: {
        'q': q,
        'city': citySlug,
        if (lat != null && lng != null) 'lat': lat,
        if (lat != null && lng != null) 'lng': lng,
      },
    );
    _ensure2xx(r);
    final list = (_m(r.data)['offers'] as List<dynamic>? ?? []);
    return list.map((x) => LocalOffer.fromJson(x as Map<String, dynamic>)).toList();
  }

  Future<List<OnlineProviderQuote>> searchOnline({required String q}) async {
    final r = await dio.get('/api/online/compare', queryParameters: {'q': q});
    _ensure2xx(r);
    final list = (_m(r.data)['providers'] as List<dynamic>? ?? []);
    return list.map((x) => OnlineProviderQuote.fromJson(x as Map<String, dynamic>)).toList();
  }

  Future<GeocodeResult> reverseGeocode({required double lat, required double lng}) async {
    final r = await dio.get('/api/geocode/reverse', queryParameters: {'lat': '$lat', 'lng': '$lng'});
    _ensure2xx(r);
    return GeocodeResult.fromJson(_m(r.data));
  }

  Future<Map<String, dynamic>> labsSearch({
    required String q,
    required String city,
    String pincode = '',
    double? lat,
    double? lng,
  }) async {
    final r = await dio.get('/api/labs/search', queryParameters: {
      'q': q,
      'city': city,
      if (pincode.trim().isNotEmpty) 'pincode': pincode.trim(),
      if (lat != null && lng != null) 'lat': lat,
      if (lat != null && lng != null) 'lng': lng,
    });
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> labsPackageDetail({
    required String packageId,
    required String city,
    String pincode = '',
    double? lat,
    double? lng,
  }) async {
    final r = await dio.get(
      '/api/labs/package/${Uri.encodeComponent(packageId)}',
      queryParameters: {
        'city': city,
        if (pincode.trim().isNotEmpty) 'pincode': pincode.trim(),
        if (lat != null && lng != null) 'lat': lat,
        if (lat != null && lng != null) 'lng': lng,
      },
    );
    _ensure2xx(r);
    return _m(r.data);
  }

  // --- Profile ---
  Future<Map<String, dynamic>> getProfileBundle() async {
    final r = await dio.get('/api/profile');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> putProfileBasic(Map<String, dynamic> body) async {
    final r = await dio.put('/api/profile/basic', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postProfileAddress(Map<String, dynamic> body) async {
    final r = await dio.post('/api/profile/addresses', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> putProfileAddress(int id, Map<String, dynamic> body) async {
    final r = await dio.put('/api/profile/addresses/$id', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> deleteProfileAddress(int id) async {
    final r = await dio.delete('/api/profile/addresses/$id');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postProfileAddressDefault(int id) async {
    final r = await dio.post('/api/profile/addresses/$id/default');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postProfilePaymentMethod(Map<String, dynamic> body) async {
    final r = await dio.post('/api/profile/payment-methods', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> putProfilePaymentMethod(int id, Map<String, dynamic> body) async {
    final r = await dio.put('/api/profile/payment-methods/$id', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> postProfilePaymentMethodDefault(int id) async {
    final r = await dio.post('/api/profile/payment-methods/$id/default');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> deleteProfilePaymentMethod(int id) async {
    final r = await dio.delete('/api/profile/payment-methods/$id');
    _ensure2xx(r);
    return _m(r.data);
  }

  // --- Prescriptions ---
  Future<Map<String, dynamic>> listPrescriptions() async {
    final r = await dio.get('/api/prescriptions');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> uploadPrescriptionFormData(FormData fd) async {
    final r = await dio.post('/api/prescriptions', data: fd);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<void> deletePrescription(int id) async {
    final r = await dio.delete('/api/prescriptions/$id');
    _ensure2xx(r);
  }

  Future<List<int>> prescriptionFileBytes(int id) async {
    final r = await dio.get<List<int>>(
      '/api/prescriptions/$id/file',
      options: Options(responseType: ResponseType.bytes),
    );
    _ensure2xx(r);
    return r.data ?? [];
  }

  // --- Orders ---
  Future<Map<String, dynamic>> createMedicineOrder(Map<String, dynamic> body) async {
    final r = await dio.post('/api/orders', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> createDiagnosticsOrder(Map<String, dynamic> body) async {
    final r = await dio.post('/api/orders/diagnostics', data: body);
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> listOrders() async {
    final r = await dio.get('/api/orders');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> getOrderDetail(int id) async {
    final r = await dio.get('/api/orders/$id');
    _ensure2xx(r);
    return _m(r.data);
  }

  // --- Razorpay (diagnostics prepaid) ---
  Future<Map<String, dynamic>> razorpayStatus() async {
    final r = await dio.get('/api/payments/razorpay/status');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> razorpayCreateOrder(double amountInr) async {
    final r = await dio.post('/api/payments/razorpay/order', data: {'amount_inr': amountInr});
    _ensure2xx(r);
    return _m(r.data);
  }

  // --- ABHA ---
  Future<Map<String, dynamic>> abhaStatus() async {
    final r = await dio.get('/api/abha/status');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> abhaLinkGet() async {
    final r = await dio.get('/api/abha/link');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> abhaAadhaarInitiate({required String healthId}) async {
    final r = await dio.post('/api/abha/aadhaar/initiate', data: {'health_id': healthId});
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> abhaAadhaarComplete({required String txnId, required String otp}) async {
    final r = await dio.post('/api/abha/aadhaar/complete', data: {'txn_id': txnId, 'otp': otp});
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> abhaSyncFromAbha() async {
    final r = await dio.post('/api/abha/sync-from-abha');
    _ensure2xx(r);
    return _m(r.data);
  }

  Future<Map<String, dynamic>> abhaPushProfile([Map<String, dynamic>? body]) async {
    final r = await dio.post('/api/abha/push-profile', data: body ?? {});
    _ensure2xx(r);
    return _m(r.data);
  }
}
