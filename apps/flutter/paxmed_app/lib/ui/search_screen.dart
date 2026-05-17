import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api_binding.dart';

import '../api/models.dart';
import '../api/client.dart';
import '../state/cart_state.dart';
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final _qCtrl = TextEditingController();
  Timer? _debounce;

  List<City> _cities = [];
  City? _city;

  bool _loadingCities = true;
  String? _status;

  bool _running = false;
  List<LocalOffer> _local = [];
  List<OnlineProviderQuote> _online = [];

  GeocodeResult? _geo;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadCities();
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _qCtrl.dispose();
    super.dispose();
  }

  PaxMedClient _client(BuildContext context) {
    return context.read<ApiBinding>().client;
  }

  Future<void> _loadCities() async {
    setState(() {
      _loadingCities = true;
      _status = 'Loading cities…';
    });
    try {
      final cities = await _client(context).getCities();
      setState(() {
        _cities = cities;
        _city = cities.isNotEmpty ? cities.first : null;
        _loadingCities = false;
        _status = null;
      });
    } catch (e) {
      setState(() {
        _loadingCities = false;
        _status = e.toString();
      });
    }
  }

  void _onQueryChanged(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 420), () {
      _runSearch();
    });
  }

  Future<void> _runSearch() async {
    final q = _qCtrl.text.trim();
    final citySlug = _city?.slug;
    if (q.isEmpty) {
      setState(() {
        _status = null;
        _local = [];
        _online = [];
      });
      return;
    }
    if (q.length < 2) {
      setState(() {
        _status = 'Enter at least 2 characters to search.';
        _local = [];
        _online = [];
      });
      return;
    }
    if (citySlug == null) return;

    setState(() {
      _running = true;
      _status = 'Searching…';
    });

    try {
      final api = _client(context);
      final geo = _geo;
      final res = await Future.wait([
        api.searchOnline(q: q),
        api.searchLocal(
          q: q,
          citySlug: citySlug,
          lat: geo?.lat,
          lng: geo?.lng,
        ),
      ]);
      if (!mounted) return;
      setState(() {
        _online = res[0] as List<OnlineProviderQuote>;
        _local = res[1] as List<LocalOffer>;
        _running = false;
        _status = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _running = false;
        _status = e.toString();
      });
    }
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
      final geo = await _client(context).reverseGeocode(lat: pos.latitude, lng: pos.longitude);
      if (!mounted) return;

      City? matched;
      if (geo.matchedCity != null) {
        matched = _cities.where((c) => c.slug == geo.matchedCity!.slug).cast<City?>().firstWhere(
              (x) => x != null,
              orElse: () => null,
            );
      }

      setState(() {
        _geo = geo;
        if (matched != null) _city = matched;
        _status = null;
      });

      await _runSearch();
    } catch (e) {
      setState(() {
        _status = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = ListView(
      padding: const EdgeInsets.all(16),
      children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Search medicines (live)', style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _qCtrl,
                    onChanged: _onQueryChanged,
                    decoration: const InputDecoration(
                      labelText: 'Medicine name',
                      hintText: 'e.g. Dolo, Metformin, Atorvastatin',
                      prefixIcon: Icon(Icons.search),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: _loadingCities
                            ? const LinearProgressIndicator()
                            : DropdownButtonFormField<City>(
                                value: _city,
                                items: _cities
                                    .map((c) => DropdownMenuItem(
                                          value: c,
                                          child: Text('${c.name}, ${c.state}'),
                                        ))
                                    .toList(),
                                onChanged: (v) {
                                  setState(() => _city = v);
                                  _runSearch();
                                },
                                decoration: const InputDecoration(labelText: 'City (demo local prices)'),
                              ),
                      ),
                      const SizedBox(width: 10),
                      FilledButton.icon(
                        onPressed: _useMyLocation,
                        icon: const Icon(Icons.my_location),
                        label: const Text('Use my location'),
                      ),
                    ],
                  ),
                  if (_geo?.formattedAddress != null) ...[
                    const SizedBox(height: 10),
                    Text(
                      _geo!.formattedAddress!,
                      style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ],
                  const SizedBox(height: 10),
                  if (_status != null) Text(_status!, style: const TextStyle(fontSize: 12)),
                  if (_running) const Padding(padding: EdgeInsets.only(top: 10), child: LinearProgressIndicator()),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          _Section(
            title: 'Online retailers (parallel)',
            subtitle: 'Uses your server’s `/api/online/compare?q=…` (partner APIs or optional catalog tokens).',
            child: _online.isEmpty
                ? const Text('No online results yet. Type at least 2 characters.')
                : Column(
                    children: _online.map((p) => _OnlineRow(q: _qCtrl.text.trim(), quote: p)).toList(),
                  ),
          ),
          const SizedBox(height: 12),
          _Section(
            title: 'Nearby pharmacies (demo database)',
            subtitle: 'Matches seeded pharmacies for the selected city via `/api/compare/search`.',
            child: _local.isEmpty
                ? const Text('No local results yet.')
                : Column(
                    children: _local.map((o) => _LocalRow(offer: o, citySlug: _city?.slug)).toList(),
                  ),
          ),
      ],
    );

    if (widget.embedded) return list;

    return Scaffold(
      appBar: AppBar(
        title: const Text('PaxMed'),
      ),
      body: list,
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget child;

  const _Section({required this.title, required this.subtitle, required this.child});

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(subtitle, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 12)),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }
}

class _OnlineRow extends StatelessWidget {
  final String q;
  final OnlineProviderQuote quote;

  const _OnlineRow({required this.q, required this.quote});

  @override
  Widget build(BuildContext context) {
    final cart = context.read<CartState>();
    final url = quote.searchUrl ?? quote.website;
    final ok = quote.ok && quote.priceInr != null;
    final price = ok ? '₹${quote.priceInr!.toStringAsFixed(2)}' : '—';
    final mrp = (ok && quote.mrpInr != null) ? '₹${quote.mrpInr!.toStringAsFixed(2)}' : '—';
    final title = quote.productTitle ?? '—';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(quote.label, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text(title, style: const TextStyle(fontSize: 12)),
                if (!quote.ok && (quote.error ?? '').isNotEmpty)
                  Text(quote.error!, style: const TextStyle(fontSize: 12)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(price, style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.primary)),
              Text(mrp, style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(width: 8),
          IconButton(
            onPressed: url == null ? null : () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
            icon: const Icon(Icons.open_in_new),
            tooltip: 'Open',
          ),
          IconButton(
            onPressed: url == null
                ? null
                : () {
                    final label = (quote.productTitle ?? q).trim();
                    final line = CartLine(
                      lineId: DateTime.now().millisecondsSinceEpoch.toString(),
                      source: CartSource.online,
                      medicineId: 0,
                      medicineLabel: label,
                      strength: null,
                      searchQuery: q,
                      unitPriceInr: quote.priceInr ?? 0,
                      mrpInr: quote.mrpInr,
                      quantity: 1,
                      packageId: null,
                      dealId: null,
                      pharmacyId: null,
                      pharmacyName: null,
                      addressLine: null,
                      pincode: null,
                      citySlug: null,
                      form: null,
                      packSize: null,
                      onlineProviderId: quote.providerId,
                      onlineLabel: quote.label,
                      checkoutUrl: url,
                    );
                    cart.addLine(line);
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Added to cart')));
                  },
            icon: const Icon(Icons.add_shopping_cart),
            tooltip: 'Add',
          ),
        ],
      ),
    );
  }
}

class _LocalRow extends StatelessWidget {
  final LocalOffer offer;
  final String? citySlug;

  const _LocalRow({required this.offer, required this.citySlug});

  @override
  Widget build(BuildContext context) {
    final cart = context.read<CartState>();
    final mapsQuery = [
      offer.addressLine,
      offer.pincode,
      offer.cityName,
      offer.pharmacyName,
    ].where((x) => (x ?? '').trim().isNotEmpty).join(' ');
    final checkoutUrl =
        'https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(mapsQuery)}';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(offer.pharmacyName, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text('${offer.medicineLabel}${offer.strength != null ? ' · ${offer.strength}' : ''}',
                    style: const TextStyle(fontSize: 12)),
                if (offer.distanceKm != null)
                  Text(
                    '${offer.distanceKm! < 10 ? offer.distanceKm!.toStringAsFixed(1) : offer.distanceKm!.round()} km away',
                    style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.tertiary),
                  ),
                Text(
                  [offer.addressLine, offer.pincode].where((x) => (x ?? '').trim().isNotEmpty).join(' · '),
                  style: const TextStyle(fontSize: 12),
                ),
                if ((offer.discountPct ?? 0) > 0.05)
                  Text(
                    '≈ ${offer.discountPct!.toStringAsFixed(1)}% vs MRP (API)',
                    style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.secondary),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('₹${offer.priceInr.toStringAsFixed(2)}',
                  style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.primary)),
              Text(offer.mrpInr == null ? '—' : '₹${offer.mrpInr!.toStringAsFixed(2)}',
                  style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(width: 8),
          IconButton(
            onPressed: () => launchUrl(Uri.parse(checkoutUrl), mode: LaunchMode.externalApplication),
            icon: const Icon(Icons.open_in_new),
            tooltip: 'Open',
          ),
          IconButton(
            onPressed: () {
              final line = CartLine(
                lineId: DateTime.now().millisecondsSinceEpoch.toString(),
                source: CartSource.local,
                medicineId: offer.medicineId,
                medicineLabel: offer.medicineLabel,
                strength: offer.strength,
                searchQuery: null,
                unitPriceInr: offer.priceInr,
                mrpInr: offer.mrpInr,
                quantity: 1,
                packageId: null,
                dealId: null,
                pharmacyId: offer.pharmacyId,
                pharmacyName: offer.pharmacyName,
                addressLine: offer.addressLine,
                pincode: offer.pincode,
                citySlug: citySlug,
                form: offer.form,
                packSize: offer.packSize,
                onlineProviderId: null,
                onlineLabel: null,
                checkoutUrl: checkoutUrl,
              );
              cart.addLine(line);
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Added to cart')));
            },
            icon: const Icon(Icons.add_shopping_cart),
            tooltip: 'Add',
          ),
        ],
      ),
    );
  }
}

