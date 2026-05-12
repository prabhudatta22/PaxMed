import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

enum CartSource { local, online, diagnostics }

class CartLine {
  final String lineId;
  final CartSource source;
  final int medicineId; // 0 if query-based (online) / diagnostics bucket
  final String medicineLabel;
  final String? strength;
  final String? searchQuery; // for online query-based merges

  final double unitPriceInr;
  final double? mrpInr;
  final int quantity;

  /// Package / deal identifiers for diagnostics (mirror web cartStore shapes).
  final String? packageId;
  final String? dealId;

  // local bucket
  final int? pharmacyId;
  final String? pharmacyName;
  final String? addressLine;
  final String? pincode;
  /// City slug — local search city; diagnostics uses same slug as `/api/labs/search?city=` value.
  final String? citySlug;

  /// Optional form metadata for pharmacy delivery payloads (parity with checkout.js fields).
  final String? form;
  final int? packSize;

  // online bucket
  final String? onlineProviderId;
  final String? onlineLabel;

  final String checkoutUrl;

  CartLine({
    required this.lineId,
    required this.source,
    required this.medicineId,
    required this.medicineLabel,
    required this.strength,
    required this.searchQuery,
    required this.unitPriceInr,
    required this.mrpInr,
    required this.quantity,
    required this.packageId,
    required this.dealId,
    required this.pharmacyId,
    required this.pharmacyName,
    required this.addressLine,
    required this.pincode,
    required this.citySlug,
    required this.form,
    required this.packSize,
    required this.onlineProviderId,
    required this.onlineLabel,
    required this.checkoutUrl,
  });

  Map<String, dynamic> toJson() => {
        'lineId': lineId,
        'source': source.name,
        'medicineId': medicineId,
        'medicineLabel': medicineLabel,
        'strength': strength,
        'searchQuery': searchQuery,
        'unitPriceInr': unitPriceInr,
        'mrpInr': mrpInr,
        'quantity': quantity,
        if (packageId != null) 'packageId': packageId,
        if (dealId != null) 'dealId': dealId,
        'pharmacyId': pharmacyId,
        'pharmacyName': pharmacyName,
        if (diagnosticsCity != null) 'city': diagnosticsCity,
        'addressLine': addressLine,
        'pincode': pincode,
        'citySlug': citySlug,
        if (form != null && form!.isNotEmpty) 'form': form,
        if (packSize != null) 'pack_size': packSize,
        'onlineProviderId': onlineProviderId,
        'onlineLabel': onlineLabel,
        'checkoutUrl': checkoutUrl,
        if (diagProviderLabel != null) 'providerName': diagProviderLabel,
      };

  /// Web `labs.js` uses `city`; we persist dual keys for interoperability.
  String? get diagnosticsCity => source == CartSource.diagnostics ? citySlug : null;

  /// Web diagnostics title uses `providerName`; we stash it in pharmacyName locally.
  String? get diagProviderLabel => source == CartSource.diagnostics ? pharmacyName : null;

  factory CartLine.fromJson(Map<String, dynamic> j) {
    double num0(dynamic x) => double.tryParse(x.toString()) ?? 0;
    double? numN(dynamic x) => x == null ? null : double.tryParse(x.toString());
    int int0(dynamic x) => int.tryParse(x.toString()) ?? 0;

    CartSource src;
    final rawSrc = (j['source'] ?? 'local').toString();
    try {
      src = CartSource.values.firstWhere((e) => e.name == rawSrc);
    } catch (_) {
      src = CartSource.local;
    }

    final slug = j['citySlug']?.toString() ?? j['city']?.toString();

    return CartLine(
      lineId: (j['lineId'] ?? '').toString(),
      source: src,
      medicineId: int0(j['medicineId']),
      medicineLabel: (j['medicineLabel'] ?? '').toString(),
      strength: j['strength']?.toString(),
      searchQuery: j['searchQuery']?.toString(),
      unitPriceInr: num0(j['unitPriceInr']),
      mrpInr: numN(j['mrpInr']),
      quantity: int0(j['quantity']).clamp(1, 99),
      packageId: j['packageId']?.toString(),
      dealId: j['dealId']?.toString(),
      pharmacyId: j['pharmacyId'] == null ? null : int0(j['pharmacyId']),
      pharmacyName:
          j['pharmacyName']?.toString() ?? j['providerName']?.toString(),
      addressLine: j['addressLine']?.toString(),
      pincode: j['pincode']?.toString(),
      citySlug: slug,
      form: j['form']?.toString(),
      packSize: j['pack_size'] == null ? null : int0(j['pack_size']),
      onlineProviderId: j['onlineProviderId']?.toString(),
      onlineLabel: j['onlineLabel']?.toString(),
      checkoutUrl: (j['checkoutUrl'] ?? '').toString(),
    );
  }
}

class CartState extends ChangeNotifier {
  static const _kKey = 'paxmed_flutter_cart_v1';
  final List<CartLine> _items = [];

  List<CartLine> get items => List.unmodifiable(_items);

  int get totalQty => _items.fold<int>(0, (s, x) => s + x.quantity);

  Iterable<CartLine> localLinesForDelivery() sync* {
    for (final l in _items) {
      if (l.source != CartSource.local) continue;
      if (l.medicineId < 1 || l.pharmacyId == null || l.pharmacyId! < 1) continue;
      yield l;
    }
  }

  Iterable<CartLine> diagnosticsLines() sync* {
    for (final l in _items) {
      if (l.source != CartSource.diagnostics) continue;
      yield l;
    }
  }

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kKey);
    if (raw == null || raw.trim().isEmpty) return;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      final list = (j['items'] as List<dynamic>? ?? []);
      _items
        ..clear()
        ..addAll(list.map((x) => CartLine.fromJson(x as Map<String, dynamic>)));
      notifyListeners();
    } catch (_) {
      // ignore
    }
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = jsonEncode({
      'items': _items.map((x) => x.toJson()).toList(),
      'updated_at': DateTime.now().millisecondsSinceEpoch,
    });
    await prefs.setString(_kKey, raw);
  }

  String _diagKey(CartLine i) {
    final p = i.packageId?.trim() ?? '';
    final d = i.dealId?.trim() ?? '';
    return p.isNotEmpty ? p : d;
  }

  bool _sameLine(CartLine i, CartLine line) {
    if (i.source != line.source) return false;

    if (line.source == CartSource.diagnostics) {
      final k = _diagKey(line);
      if (k.isEmpty || k != _diagKey(i)) return false;
      final ci = (i.citySlug ?? '').toLowerCase().trim();
      final cl = (line.citySlug ?? '').toLowerCase().trim();
      return ci == cl && cl.isNotEmpty;
    }

    if (line.source == CartSource.local) {
      return i.medicineId == line.medicineId && i.pharmacyId == line.pharmacyId;
    }

    if (i.onlineProviderId != line.onlineProviderId) return false;
    if (i.medicineId > 0 && line.medicineId > 0) return i.medicineId == line.medicineId;
    if (i.medicineId > 0 || line.medicineId > 0) return false;
    final qi = (i.searchQuery ?? '').toLowerCase();
    final ql = (line.searchQuery ?? '').toLowerCase();
    final li = i.medicineLabel.toLowerCase();
    final ll = line.medicineLabel.toLowerCase();
    return ql.isNotEmpty && qi == ql && li == ll;
  }

  Future<void> addLine(CartLine line, {int qty = 1}) async {
    final q = qty.clamp(1, 99);
    final idx = _items.indexWhere((x) => _sameLine(x, line));
    if (idx >= 0) {
      final cur = _items[idx];
      final nextQty = (cur.quantity + q).clamp(1, 99);
      _items[idx] = CartLine(
        lineId: cur.lineId,
        source: cur.source,
        medicineId: cur.medicineId,
        medicineLabel: cur.medicineLabel,
        strength: cur.strength,
        searchQuery: cur.searchQuery,
        unitPriceInr: cur.unitPriceInr,
        mrpInr: cur.mrpInr,
        quantity: nextQty,
        packageId: cur.packageId,
        dealId: cur.dealId,
        pharmacyId: cur.pharmacyId,
        pharmacyName: cur.pharmacyName,
        addressLine: cur.addressLine,
        pincode: cur.pincode,
        citySlug: cur.citySlug,
        form: cur.form,
        packSize: cur.packSize,
        onlineProviderId: cur.onlineProviderId,
        onlineLabel: cur.onlineLabel,
        checkoutUrl: cur.checkoutUrl,
      );
    } else {
      final withQty = CartLine(
        lineId: line.lineId,
        source: line.source,
        medicineId: line.medicineId,
        medicineLabel: line.medicineLabel,
        strength: line.strength,
        searchQuery: line.searchQuery,
        unitPriceInr: line.unitPriceInr,
        mrpInr: line.mrpInr,
        quantity: q,
        packageId: line.packageId,
        dealId: line.dealId,
        pharmacyId: line.pharmacyId,
        pharmacyName: line.pharmacyName,
        addressLine: line.addressLine,
        pincode: line.pincode,
        citySlug: line.citySlug,
        form: line.form,
        packSize: line.packSize,
        onlineProviderId: line.onlineProviderId,
        onlineLabel: line.onlineLabel,
        checkoutUrl: line.checkoutUrl,
      );
      _items.add(withQty);
    }
    notifyListeners();
    await _save();
  }

  Future<void> setQty(String lineId, int qty) async {
    final q = qty.clamp(1, 99);
    final idx = _items.indexWhere((x) => x.lineId == lineId);
    if (idx < 0) return;
    final cur = _items[idx];
    if (cur.source == CartSource.diagnostics) return;
    _items[idx] = CartLine(
      lineId: cur.lineId,
      source: cur.source,
      medicineId: cur.medicineId,
      medicineLabel: cur.medicineLabel,
      strength: cur.strength,
      searchQuery: cur.searchQuery,
      unitPriceInr: cur.unitPriceInr,
      mrpInr: cur.mrpInr,
      quantity: q,
      packageId: cur.packageId,
      dealId: cur.dealId,
      pharmacyId: cur.pharmacyId,
      pharmacyName: cur.pharmacyName,
      addressLine: cur.addressLine,
      pincode: cur.pincode,
      citySlug: cur.citySlug,
      form: cur.form,
      packSize: cur.packSize,
      onlineProviderId: cur.onlineProviderId,
      onlineLabel: cur.onlineLabel,
      checkoutUrl: cur.checkoutUrl,
    );
    notifyListeners();
    await _save();
  }

  Future<void> remove(String lineId) async {
    _items.removeWhere((x) => x.lineId == lineId);
    notifyListeners();
    await _save();
  }

  Future<void> removeDiagnosticsLines() async {
    _items.removeWhere((x) => x.source == CartSource.diagnostics);
    notifyListeners();
    await _save();
  }

  Future<void> removeLocalDeliveryEligible() async {
    _items.removeWhere(
      (x) => x.source == CartSource.local && x.medicineId >= 1 && x.pharmacyId != null && x.pharmacyId! >= 1,
    );
    notifyListeners();
    await _save();
  }

  Future<void> clear() async {
    _items.clear();
    notifyListeners();
    await _save();
  }
}
