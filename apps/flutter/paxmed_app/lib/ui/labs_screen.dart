import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';

import '../api/client.dart';
import '../core/api_binding.dart';
import '../state/cart_state.dart';
import '../state/settings_state.dart';
import '../api/models.dart';

class LabsScreen extends StatefulWidget {
  const LabsScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  State<LabsScreen> createState() => _LabsScreenState();
}

class _LabsScreenState extends State<LabsScreen> {
  Timer? _debounce;
  final _qCtrl = TextEditingController();
  final _pinCtrl = TextEditingController();

  List<City> _cities = [];
  City? _city;
  bool _loadingCities = true;
  List<Map<String, dynamic>> _rows = [];
  String? _status;
  bool _running = false;
  GeocodeResult? _geo;

  @override
  void dispose() {
    _debounce?.cancel();
    _qCtrl.dispose();
    _pinCtrl.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    setState(() => _loadingCities = true);
    try {
      final c = context.read<ApiBinding>().client;
      final cities = await c.getCities();
      if (!mounted) return;
      setState(() {
        _cities = cities;
        _city = cities.isNotEmpty ? cities.first : null;
        _loadingCities = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingCities = false);
    }
  }

  PaxMedClient _c() => context.read<ApiBinding>().client;

  void _debouncedSearch() {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 380), () {
      _runSearch();
    });
  }

  Future<void> _useMyLocation() async {
    setState(() {
      _status = 'Checking location permission…';
    });

    final enabled = await Geolocator.isLocationServiceEnabled();
    if (!enabled) {
      setState(() {
        _status = 'Location services are disabled. Enable GPS and try again.';
      });
      return;
    }

    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
      setState(() {
        _status = 'Location permission denied. Pick a city manually.';
      });
      return;
    }

    setState(() {
      _status = 'Getting coordinates…';
    });

    try {
      final pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
      setState(() {
        _status = 'Looking up address…';
      });
      final geo = await _c().reverseGeocode(lat: pos.latitude, lng: pos.longitude);
      if (!mounted) return;

      City? matched;
      final mc = geo.matchedCity;
      if (mc != null) {
        for (final c in _cities) {
          if (c.slug == mc.slug) {
            matched = c;
            break;
          }
        }
      }

      setState(() {
        _geo = geo;
        if (matched != null) _city = matched;
        _status = null;
      });

      await _runSearch();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _status = e.toString();
      });
    }
  }

  Future<void> _runSearch() async {
    final q = _qCtrl.text.trim();
    final slug = _city?.slug;
    if (slug == null) return;

    if (q.length < 2) {
      setState(() {
        _rows = [];
        _running = false;
        _status = null;
      });
      return;
    }

    setState(() {
      _running = true;
      _status = 'Searching labs…';
    });

    try {
      final geo = _geo;
      final bundle = await _c().labsSearch(
        q: q,
        city: slug,
        pincode: _pinCtrl.text.trim(),
        lat: geo?.lat,
        lng: geo?.lng,
      );
      final raw = bundle['items'] as List<dynamic>? ?? [];
      if (!mounted) return;
      setState(() {
        _rows = raw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _status = null;
        _running = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _status = e.toString();
        _rows = [];
        _running = false;
      });
    }
  }

  void _addToCart(BuildContext ctx, Map<String, dynamic> it) {
    final cart = ctx.read<CartState>();
    final slug = (_city?.slug ?? '').trim();
    if (slug.isEmpty) return;

    final packageId =
        '${it['package_id'] ?? it['id'] ?? ''}'.trim();
    final dealId = '${it['deal_id'] ?? packageId}'.trim();
    final heading = (it['heading'] ?? '').toString();
    final price =
        double.tryParse('${it['price_inr']}') ?? 0;
    final mrpN = double.tryParse('${it['mrp_inr'] ?? ''}');
    final mrp = (mrpN != null && mrpN > 0) ? mrpN : null;

    final provider = switch ('${it['provider']}'.toLowerCase()) {
      'healthians' => 'Healthians',
      _ => (it['lab_name'] ?? 'Diagnostics').toString(),
    };

    if (heading.isEmpty || packageId.isEmpty || price <= 0) return;

    final line = CartLine(
      lineId: '${DateTime.now().millisecondsSinceEpoch}-${packageId.hashCode}',
      source: CartSource.diagnostics,
      medicineId: 0,
      medicineLabel: heading,
      strength: (it['sub_heading'] ?? '').toString().trim().isEmpty ? null : it['sub_heading'].toString(),
      searchQuery: null,
      unitPriceInr: price,
      mrpInr: mrp,
      quantity: 1,
      packageId: packageId,
      dealId: dealId.isEmpty ? packageId : dealId,
      pharmacyId: null,
      pharmacyName: provider,
      addressLine: null,
      pincode: null,
      citySlug: slug.toLowerCase(),
      form: null,
      packSize: null,
      onlineProviderId: null,
      onlineLabel: null,
      checkoutUrl: '',
    );

    cart.addLine(line);

    ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text('Added: $heading')));
  }

  @override
  Widget build(BuildContext context) {
    final bodyContent = Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Diagnostics search', style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _qCtrl,
                    onChanged: (_) => _debouncedSearch(),
                    decoration: const InputDecoration(
                      labelText: 'Lab test keyword',
                      hintText: 'e.g. CBC, thyroid profile',
                      prefixIcon: Icon(Icons.search),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: _loadingCities
                            ? const LinearProgressIndicator()
                            : DropdownButtonFormField<City>(
                                value: _city,
                                items: _cities
                                    .map((c) => DropdownMenuItem(value: c, child: Text('${c.name}, ${c.state}')))
                                    .toList(),
                                onChanged: (v) {
                                  setState(() => _city = v);
                                  _runSearch();
                                },
                                decoration: const InputDecoration(labelText: 'City slug'),
                              ),
                      ),
                      const SizedBox(width: 10),
                      SizedBox(
                        width: 120,
                        child: TextField(
                          controller: _pinCtrl,
                          decoration: const InputDecoration(labelText: 'Pincode'),
                          onChanged: (_) => _debouncedSearch(),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton.icon(
                      onPressed: _running ? null : _useMyLocation,
                      icon: const Icon(Icons.my_location, size: 18),
                      label: const Text('Use my location'),
                    ),
                  ),
                  if ((_geo?.formattedAddress ?? '').trim().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 10),
                      child: Text(
                        _geo!.formattedAddress!.trim(),
                        style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant),
                      ),
                    ),
                  const SizedBox(height: 8),
                  Text(
                    context.read<SettingsState>().baseUrl,
                    style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant),
                  ),
                  if (_running) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
                  if ((_status ?? '').trim().isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_status!, style: const TextStyle(fontSize: 12))),
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: ListView.builder(
              itemCount: _rows.length,
              itemBuilder: (ctx, i) {
                final it = _rows[i];
                final heading = '${it['heading'] ?? ''}';
                final sub = '${it['sub_heading'] ?? ''}';
                final labName = '${it['lab_name'] ?? ''}';
                final price =
                    double.tryParse('${it['price_inr'] ?? ''}') ?? 0;
                final mrp = double.tryParse('${it['mrp_inr'] ?? ''}');
                double? pct;
                if (it['discount_pct'] != null) {
                  final d = double.tryParse('${it['discount_pct']}');
                  pct = (d != null && d > 0) ? d : null;
                }
                return Card(
                  child: ListTile(
                    title: Text(heading.isEmpty ? 'Package' : heading),
                    subtitle: Text([
                      labName,
                      sub,
                      if (pct != null) '${pct.toStringAsFixed(1)}% vs MRP (API)',
                    ].where((s) => s.trim().isNotEmpty).join(' · ')),
                    trailing: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text('₹${price.toStringAsFixed(2)}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        if ((mrp ?? 0) > price && price > 0)
                          Text('MRP ₹${mrp!.toStringAsFixed(2)}',
                              style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant)),
                      ],
                    ),
                    onTap: () => _addToCart(context, it),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Tip: tapping a lab card adds this package/deal pair to your cart (stored locally). Checkout requires a logged-in consumer account.',
            style: TextStyle(fontSize: 11),
          ),
        ],
      ),
    );

    if (widget.embedded) {
      return bodyContent;
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Labs')),
      body: bodyContent,
    );
  }
}
