import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../core/api_binding.dart';
import '../state/cart_state.dart';
import 'cart_screen.dart';
import 'labs_screen.dart';

abstract final class _SearchTheme {
  static const surface = Color(0xFFF7F9FB);
  static const surfaceWhite = Color(0xFFFFFFFF);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const primary = Color(0xFF006194);
  static const secondary = Color(0xFF006B5F);
  static const onSurface = Color(0xFF191C1E);
  static const onSurfaceVariant = Color(0xFF3F4850);
  static const successGreen = Color(0xFF16A34A);
  static const gridLine = Color(0x08006194);
}

class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

/// Light teal grid backdrop (same as Stitch order-history).
class _SearchGridPainter extends CustomPainter {
  const _SearchGridPainter();

  @override
  void paint(Canvas canvas, Size size) {
    const step = 48.0;
    final p = Paint()
      ..color = _SearchTheme.gridLine
      ..strokeWidth = 1;
    for (var x = 0.0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), p);
    }
    for (var y = 0.0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SearchScreenState extends State<SearchScreen> {
  static const _kHistoryKey = 'paxmed_meds_search_history_v1';

  final _qCtrl = TextEditingController();
  final _searchFocus = FocusNode();
  Timer? _debounce;

  List<City> _cities = [];
  City? _city;

  bool _loadingCities = true;
  String? _status;

  bool _running = false;
  List<LocalOffer> _local = [];
  List<OnlineProviderQuote> _online = [];

  GeocodeResult? _geo;
  List<String> _history = [];

  bool _showSuggestions = false;

  PaxMedClient _client(BuildContext context) => context.read<ApiBinding>().client;

  @override
  void initState() {
    super.initState();
    _qCtrl.addListener(() {
      if (!mounted) return;
      setState(() {});
    });
    _searchFocus.addListener(() {
      if (!_searchFocus.hasFocus) {
        setState(() => _showSuggestions = false);
      } else {
        setState(() {
          _showSuggestions = _history.isNotEmpty || _qCtrl.text.trim().isNotEmpty;
        });
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await _loadCities();
      await _loadHistory();
    });
  }

  Future<void> _loadHistory() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final xs = prefs.getStringList(_kHistoryKey);
      setState(() {
        _history = xs ?? [];
      });
    } catch (_) {}
  }

  Future<void> _pushHistory(String raw) async {
    final q = raw.trim();
    if (q.length < 2) return;
    final next = <String>[
      q,
      ..._history.where((x) => x.toLowerCase() != q.toLowerCase()),
    ].take(10).toList();
    _history = next;
    if (mounted) setState(() {});
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_kHistoryKey, next);
    } catch (_) {}
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _qCtrl.dispose();
    _searchFocus.dispose();
    super.dispose();
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
    final hasText = _qCtrl.text.trim().isNotEmpty;
    setState(() {
      _showSuggestions = (_searchFocus.hasFocus && hasText) || (_searchFocus.hasFocus && _history.isNotEmpty);
    });
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
      await _pushHistory(q);
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

  Future<void> _applySuggestion(String suggestion) async {
    _qCtrl.text = suggestion;
    setState(() {
      _showSuggestions = false;
    });
    _searchFocus.unfocus();
    await _runSearch();
  }

  Future<void> _pickCitySheet() async {
    final selected = await showModalBottomSheet<City>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ListView.builder(
          itemCount: _cities.length,
          itemBuilder: (_, i) {
            final c = _cities[i];
            final isSel = _city?.slug == c.slug;
            return ListTile(
              title: Text('${c.name}, ${c.state}'),
              trailing: isSel ? const Icon(Icons.check, color: _SearchTheme.primary) : null,
              onTap: () => Navigator.pop(ctx, c),
            );
          },
        ),
      ),
    );
    if (selected != null) {
      setState(() => _city = selected);
      await _runSearch();
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

  Iterable<String> get _filteredHistory {
    final q = _qCtrl.text.trim().toLowerCase();
    final xs = _history.where((h) => q.isEmpty || h.toLowerCase().startsWith(q));
    return xs.take(5);
  }

  static int? _discountPct({required double price, double? mrp}) {
    if (mrp == null || mrp <= 0 || price <= 0) return null;
    if (mrp <= price) return null;
    return (((mrp - price) / mrp) * 100).round();
  }

  List<_OfferCardModel> _buildMergedOffers() {
    final rows = <_OfferCardModel>[];

    for (final quote in _online) {
      final ok = quote.ok && quote.priceInr != null;
      final unit = ok ? quote.priceInr : null;
      final pct = unit != null ? _discountPct(price: unit, mrp: quote.mrpInr) : null;
      rows.add(_OfferCardModel(
        isOnline: true,
        bestPrice: false,
        pharmacyName: quote.label,
        productLine: (quote.productTitle ?? quote.label).trim().isEmpty ? quote.label : (quote.productTitle ?? quote.label),
        subtitleIcon: Icons.language_rounded,
        distanceKmText: null,
        priceInr: unit,
        mrpInr: quote.mrpInr,
        discountPctRounded: pct,
        errorText: !ok ? (quote.error ?? 'Unavailable') : null,
        quote: quote,
        offer: null,
        citySlug: _city?.slug,
        searchQuery: _qCtrl.text.trim(),
      ));
    }

    for (final offer in _local) {
      final apiPct = offer.discountPct;
      final pct = apiPct != null && apiPct > 0.05 ? apiPct.round() : _discountPct(price: offer.priceInr, mrp: offer.mrpInr);
      final distance = offer.distanceKm == null
          ? null
          : (offer.distanceKm! < 10 ? '${offer.distanceKm!.toStringAsFixed(1)} km away' : '${offer.distanceKm!.round()} km away');
      rows.add(_OfferCardModel(
        isOnline: false,
        bestPrice: false,
        pharmacyName: offer.pharmacyName,
        productLine: '${offer.medicineLabel}${offer.strength != null ? ' · ${offer.strength}' : ''}',
        subtitleIcon: Icons.location_on_rounded,
        distanceKmText: distance,
        priceInr: offer.priceInr,
        mrpInr: offer.mrpInr,
        discountPctRounded: pct,
        errorText: null,
        quote: null,
        offer: offer,
        citySlug: _city?.slug,
        searchQuery: _qCtrl.text.trim(),
      ));
    }

    rows.sort((a, b) {
      final pa = a.priceInr;
      final pb = b.priceInr;
      if (pa != null && pb != null && pa != pb) return pa.compareTo(pb);
      if (pa != null && pb == null) return -1;
      if (pa == null && pb != null) return 1;
      return a.pharmacyName.toLowerCase().compareTo(b.pharmacyName.toLowerCase());
    });

    final priced = rows.where((r) => r.priceInr != null && r.priceInr! > 0).toList();
    if (priced.length < 2) return rows;

    final minPrice = priced.map((r) => r.priceInr!).reduce((a, b) => a <= b ? a : b);

    bool nearMin(double? p) {
      if (p == null || p <= 0) return false;
      return (p - minPrice).abs() < 0.005;
    }

    return rows
        .map((r) => nearMin(r.priceInr) ? r.copyWith(bestPrice: true) : r.copyWith(bestPrice: false))
        .toList();
  }

  Widget _searchBlock() => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 4),
          Focus(
            onFocusChange: (hasFocus) {
              setState(() {
                _showSuggestions =
                    hasFocus && (_history.isNotEmpty || _qCtrl.text.trim().isNotEmpty || _filteredHistory.take(1).isNotEmpty);
              });
            },
            child: TextField(
              controller: _qCtrl,
              focusNode: _searchFocus,
              onChanged: _onQueryChanged,
              decoration: InputDecoration(
                hintText: 'Search medicines, tests, and more…',
                hintStyle: TextStyle(color: Colors.grey.shade600, fontWeight: FontWeight.w400),
                filled: true,
                fillColor: _SearchTheme.surfaceWhite,
                prefixIcon: const Icon(Icons.search_rounded, color: _SearchTheme.primary),
                suffixIcon: _qCtrl.text.trim().isEmpty
                    ? null
                    : IconButton(
                        onPressed: () {
                          _qCtrl.clear();
                          setState(() {
                            _showSuggestions = _searchFocus.hasFocus && _history.isNotEmpty;
                            _local = [];
                            _online = [];
                            _status = null;
                          });
                          _debounce?.cancel();
                        },
                        icon: const Icon(Icons.close_rounded, color: _SearchTheme.primary),
                      ),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: const BorderSide(color: _SearchTheme.primary, width: 2),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: const BorderSide(color: _SearchTheme.primary, width: 2),
                ),
              ),
            ),
          ),
          AnimatedCrossFade(
            firstChild: const SizedBox(height: 0),
            secondChild: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: _SearchTheme.surfaceWhite,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: _SearchTheme.outlineVariant),
                  boxShadow: [
                    BoxShadow(color: Colors.black.withValues(alpha: 0.08), blurRadius: 16, offset: const Offset(0, 8)),
                  ],
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = 0; i < _filteredHistory.length; i++)
                      InkWell(
                        onTap: () => _applySuggestion(_filteredHistory.elementAt(i)),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                          child: Row(
                            children: [
                              Icon(_suggestionLeadingIcon(i), size: 22, color: _SearchTheme.onSurfaceVariant),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Text(
                                  _filteredHistory.elementAt(i),
                                  style: const TextStyle(fontSize: 16, height: 1.45, fontWeight: FontWeight.w400, color: _SearchTheme.onSurface),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            crossFadeState: (_showSuggestions && _filteredHistory.isNotEmpty && _running == false && _loadingCities == false)
                ? CrossFadeState.showSecond
                : CrossFadeState.showFirst,
            duration: const Duration(milliseconds: 140),
          ),
          const SizedBox(height: 10),
          if (_loadingCities)
            const LinearProgressIndicator(color: _SearchTheme.primary),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              ActionChip(
                avatar: Icon(_city != null ? Icons.place_outlined : Icons.place, size: 18, color: _SearchTheme.primary),
                label: Text(_city?.name ?? 'City'),
                onPressed: _pickCitySheet,
                visualDensity: VisualDensity.compact,
                surfaceTintColor: _SearchTheme.primary,
              ),
              ActionChip(
                avatar: Icon(Icons.my_location_rounded, size: 18, color: _SearchTheme.secondary),
                label: const Text('Locate'),
                onPressed: _useMyLocation,
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
          if ((_geo?.formattedAddress ?? '').trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _geo!.formattedAddress!.trim(),
                style: TextStyle(fontSize: 12, height: 1.35, color: Colors.grey.shade700),
              ),
            ),
          if ((_status ?? '').trim().isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(_status!, style: TextStyle(fontSize: 13, height: 1.35, color: Colors.red.shade800)),
          ],
          if (_running)
            const Padding(
              padding: EdgeInsets.only(top: 14),
              child: LinearProgressIndicator(color: _SearchTheme.primary),
            ),
        ],
      );

  IconData _suggestionLeadingIcon(int i) {
    switch (i % 3) {
      case 0:
        return Icons.history_rounded;
      case 1:
        return Icons.medical_services_rounded;
      default:
        return Icons.science_rounded;
    }
  }

  Widget _diagnosticsUpsell(BuildContext context) => Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
        decoration: BoxDecoration(
          color: _SearchTheme.primary.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _SearchTheme.primary.withValues(alpha: 0.22)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Icon(Icons.balance_rounded, size: 32, color: _SearchTheme.primary.withValues(alpha: 0.9)),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Need a diagnostic test?',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, height: 1.15, color: _SearchTheme.onSurface),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Explore lab packages and booking from PaxMed Diagnostics.',
                    style: TextStyle(fontSize: 13, height: 1.38, color: Colors.grey.shade700),
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => const LabsScreen(embedded: false),
                  ),
                );
              },
              style: TextButton.styleFrom(
                foregroundColor: _SearchTheme.primary,
              ),
              child: const Text('Explore tests', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ],
        ),
      );

  static String _formatPrice(double? v) {
    if (v == null || v <= 0) return '—';
    final s = v.toStringAsFixed(2);
    if (s.endsWith('.00')) return '₹${s.substring(0, s.length - 3)}';
    return '₹$s';
  }

  Widget _wrappedBody(BuildContext context) {
    final padBottom = widget.embedded ? 88.0 + MediaQuery.paddingOf(context).bottom : 32.0;
    final query = _qCtrl.text.trim();
    final merged = _buildMergedOffers();

    final children = <Widget>[
      _searchBlock(),
    ];

    if (query.length >= 2) {
      children.add(const SizedBox(height: 26));
      children.add(Text(
        'Results for \"$query\"',
        style: const TextStyle(fontSize: 18, height: 1.35, fontWeight: FontWeight.w600, color: _SearchTheme.onSurface),
      ));
      children.add(const SizedBox(height: 14));

      if (!_running && merged.isEmpty) {
        children.add(
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(
              _city != null ? 'No offers found for \"$query\" in ${_city!.name}. Try another spelling or retailer.' : 'Pick a city to search local pharmacies.',
              style: TextStyle(fontSize: 14, height: 1.45, color: Colors.grey.shade700),
            ),
          ),
        );
      } else if (_running && merged.isEmpty) {
        children.add(const Center(
          child: Padding(
            padding: EdgeInsets.symmetric(vertical: 36),
            child: CircularProgressIndicator(color: _SearchTheme.primary),
          ),
        ));
      } else {
        if (_running && merged.isNotEmpty) {
          children.add(
            Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    SizedBox(
                      height: 16,
                      width: 16,
                      child: CircularProgressIndicator(color: Theme.of(context).colorScheme.primary, strokeWidth: 2),
                    ),
                    const SizedBox(width: 10),
                    Text('Updating results…', style: TextStyle(fontSize: 13, color: Colors.grey.shade700)),
                  ],
                ),
              ),
            ),
          );
        }
        for (final row in merged) {
          children.add(Padding(padding: const EdgeInsets.only(bottom: 14), child: _OfferResultCard(model: row)));
        }
      }
    }

    children.add(const SizedBox(height: 8));
    children.add(_diagnosticsUpsell(context));
    children.add(SizedBox(height: padBottom));

    return Stack(
      children: [
        Positioned.fill(child: CustomPaint(painter: _SearchGridPainter())),
        RefreshIndicator(
          color: _SearchTheme.primary,
          onRefresh: () async => _runSearch(),
          displacement: widget.embedded ? 28 : 8,
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                sliver: SliverList(delegate: SliverChildListDelegate(children)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final shell = ColoredBox(
      color: _SearchTheme.surface,
      child: _wrappedBody(context),
    );

    if (widget.embedded) return shell;

    return Scaffold(
      backgroundColor: _SearchTheme.surface,
      appBar: AppBar(
        backgroundColor: Colors.white.withValues(alpha: 0.94),
        elevation: 0.5,
        shadowColor: Colors.black.withValues(alpha: 0.08),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.search_rounded, color: Theme.of(context).colorScheme.primary, size: 26),
            const SizedBox(width: 10),
            Text('PaxMed', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Theme.of(context).colorScheme.primary)),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Cart',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const CartScreen(embedded: false),
              ),
            ),
            icon: Icon(Icons.shopping_cart_outlined, color: Colors.grey.shade800),
          ),
        ],
      ),
      body: shell,
    );
  }
}

class _OfferCardModel {
  const _OfferCardModel({
    required this.isOnline,
    required this.bestPrice,
    required this.pharmacyName,
    required this.productLine,
    required this.subtitleIcon,
    required this.distanceKmText,
    required this.priceInr,
    required this.mrpInr,
    required this.discountPctRounded,
    required this.errorText,
    required this.quote,
    required this.offer,
    required this.citySlug,
    required this.searchQuery,
  });

  final bool isOnline;
  final bool bestPrice;
  final String pharmacyName;
  final String productLine;
  final IconData subtitleIcon;
  final String? distanceKmText;
  final double? priceInr;
  final double? mrpInr;
  final int? discountPctRounded;
  final String? errorText;
  final OnlineProviderQuote? quote;
  final LocalOffer? offer;
  final String? citySlug;
  final String searchQuery;

  _OfferCardModel copyWith({bool? bestPrice}) => _OfferCardModel(
        isOnline: isOnline,
        bestPrice: bestPrice ?? this.bestPrice,
        pharmacyName: pharmacyName,
        productLine: productLine,
        subtitleIcon: subtitleIcon,
        distanceKmText: distanceKmText,
        priceInr: priceInr,
        mrpInr: mrpInr,
        discountPctRounded: discountPctRounded,
        errorText: errorText,
        quote: quote,
        offer: offer,
        citySlug: citySlug,
        searchQuery: searchQuery,
      );
}

class _OfferResultCard extends StatefulWidget {
  const _OfferResultCard({required this.model});

  final _OfferCardModel model;

  @override
  State<_OfferResultCard> createState() => _OfferResultCardState();
}

class _OfferResultCardState extends State<_OfferResultCard> {
  bool _flashAdded = false;

  Future<void> _pulseAdded() async {
    setState(() => _flashAdded = true);
    await Future<void>.delayed(const Duration(milliseconds: 1800));
    if (mounted) setState(() => _flashAdded = false);
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.model;
    final cart = context.read<CartState>();

    Widget logo() {
      final raw = m.pharmacyName.trim();
      final letter = raw.isEmpty
          ? '?'
          : String.fromCharCode(raw.runes.first).toUpperCase();
      return Container(
        width: 48,
        height: 48,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Colors.grey.shade100,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: _SearchTheme.outlineVariant),
        ),
        child: Text(
          letter,
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.grey.shade800),
        ),
      );
    }

    Future<void> onAdd() async {
      if (_flashAdded) return;
      final line = _composeCartLine(context, m);
      if (line == null) return;
      cart.addLine(line);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Added from ${m.pharmacyName}')));
        await _pulseAdded();
      }
    }

    Future<void> openExternal() async {
      if (m.isOnline) {
        final url = m.quote?.searchUrl ?? m.quote?.website;
        if (url == null || url.isEmpty) return;
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      } else if (m.offer != null) {
        final o = m.offer!;
        final mapsQuery = [o.addressLine, o.pincode, o.cityName, o.pharmacyName].where((x) => (x ?? '').trim().isNotEmpty).join(' ');
        final u = 'https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(mapsQuery)}';
        await launchUrl(Uri.parse(u), mode: LaunchMode.externalApplication);
      }
    }

    final pct = m.discountPctRounded;
    final pctLabel = pct != null && pct > 0 ? '$pct% OFF' : null;

    return Material(
      color: Colors.transparent,
      child: Container(
        decoration: BoxDecoration(
          color: _SearchTheme.surfaceWhite,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            width: m.bestPrice ? 2 : 1,
            color: m.bestPrice ? _SearchTheme.secondary.withValues(alpha: 0.38) : const Color(0xFFE2E8F0),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: m.bestPrice ? 0.06 : 0.04),
              blurRadius: m.bestPrice ? 14 : 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        clipBehavior: Clip.antiAlias,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            if (m.bestPrice)
              Positioned(
                top: 0,
                right: 0,
                child: DecoratedBox(
                  decoration: const BoxDecoration(
                    color: _SearchTheme.secondary,
                    borderRadius: BorderRadius.only(bottomLeft: Radius.circular(14)),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 6, 12, 6),
                    child: Text(
                      'BEST PRICE',
                      style: TextStyle(
                        fontSize: 9,
                        letterSpacing: 0.65,
                        fontWeight: FontWeight.w800,
                        color: Colors.white.withValues(alpha: 0.95),
                      ),
                    ),
                  ),
                ),
              ),
            Padding(
              padding: EdgeInsets.fromLTRB(16, m.bestPrice ? 22 : 16, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      logo(),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              m.pharmacyName,
                              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16, height: 1.25),
                            ),
                            const SizedBox(height: 4),
                            Row(
                              children: [
                                Icon(m.subtitleIcon, size: 16, color: _SearchTheme.onSurfaceVariant),
                                const SizedBox(width: 6),
                                Expanded(
                                  child: Text(
                                    m.isOnline ? 'Online delivery' : (m.distanceKmText ?? m.offer?.cityName ?? 'Nearby'),
                                    style: const TextStyle(fontSize: 13, height: 1.35, color: _SearchTheme.onSurfaceVariant),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Text(
                              m.productLine,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13, height: 1.35, color: Colors.grey.shade800),
                            ),
                            if ((m.errorText ?? '').trim().isNotEmpty) ...[
                              const SizedBox(height: 8),
                              Text(m.errorText!, style: TextStyle(fontSize: 11, height: 1.35, color: Colors.red.shade800)),
                            ],
                          ],
                        ),
                      ),
                      if (pctLabel != null)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
                          decoration: BoxDecoration(
                            color: _SearchTheme.successGreen.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            pctLabel,
                            style: const TextStyle(
                              fontWeight: FontWeight.w800,
                              fontSize: 10,
                              letterSpacing: 0.52,
                              color: _SearchTheme.successGreen,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Divider(height: 1, color: _SearchTheme.outlineVariant.withValues(alpha: 0.55)),
                  const SizedBox(height: 14),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Expanded(
                        child: Row(
                          children: [
                            Text(
                              _SearchScreenState._formatPrice(m.priceInr),
                              style: TextStyle(
                                fontSize: m.priceInr == null ? 15 : 20,
                                fontWeight: FontWeight.w900,
                                color: Theme.of(context).colorScheme.primary,
                              ),
                            ),
                            if ((m.mrpInr ?? 0) > 0 &&
                                (m.priceInr ?? 0) > 0 &&
                                (m.mrpInr! > m.priceInr! || (m.mrpInr! - m.priceInr!).abs() > 0.01))
                              Padding(
                                padding: const EdgeInsets.only(left: 10),
                                child: Text(
                                  _SearchScreenState._formatPrice(m.mrpInr),
                                  style: const TextStyle(
                                    fontSize: 13,
                                    decoration: TextDecoration.lineThrough,
                                    color: _SearchTheme.onSurfaceVariant,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      IconButton(
                        tooltip: 'Open',
                        constraints: const BoxConstraints(minWidth: 42, minHeight: 42),
                        padding: EdgeInsets.zero,
                        visualDensity: VisualDensity.compact,
                        onPressed: () => openExternal(),
                        icon: const Icon(Icons.open_in_new_rounded, size: 22, color: _SearchTheme.outline),
                      ),
                      const SizedBox(width: 2),
                      FilledButton.icon(
                        onPressed: (_flashAdded || m.priceInr == null || m.priceInr! <= 0)
                            ? null
                            : () => onAdd(),
                        style: FilledButton.styleFrom(
                          elevation: 0,
                          disabledBackgroundColor: Colors.grey.shade300,
                          backgroundColor: _flashAdded ? _SearchTheme.successGreen : _SearchTheme.secondary,
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                        ),
                        icon: Icon(_flashAdded ? Icons.check_rounded : Icons.add_shopping_cart_rounded, size: 18),
                        label: Text(_flashAdded ? 'Added' : 'Add to cart'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  CartLine? _composeCartLine(BuildContext cx, _OfferCardModel m) {
    if (m.isOnline) {
      final quote = m.quote!;
      final url = quote.searchUrl ?? quote.website;
      if (url == null) return null;
      final label = (quote.productTitle ?? m.searchQuery).trim();
      return CartLine(
        lineId: DateTime.now().millisecondsSinceEpoch.toString(),
        source: CartSource.online,
        medicineId: 0,
        medicineLabel: label,
        strength: null,
        searchQuery: m.searchQuery,
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
    }

    final o = m.offer!;
    final mapsQuery = [o.addressLine, o.pincode, o.cityName, o.pharmacyName].where((x) => (x ?? '').trim().isNotEmpty).join(' ');
    final checkoutUrl = 'https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(mapsQuery)}';

    return CartLine(
      lineId: DateTime.now().millisecondsSinceEpoch.toString(),
      source: CartSource.local,
      medicineId: o.medicineId,
      medicineLabel: o.medicineLabel,
      strength: o.strength,
      searchQuery: null,
      unitPriceInr: o.priceInr,
      mrpInr: o.mrpInr,
      quantity: 1,
      packageId: null,
      dealId: null,
      pharmacyId: o.pharmacyId,
      pharmacyName: o.pharmacyName,
      addressLine: o.addressLine,
      pincode: o.pincode,
      citySlug: m.citySlug,
      form: o.form,
      packSize: o.packSize,
      onlineProviderId: null,
      onlineLabel: null,
      checkoutUrl: checkoutUrl,
    );
  }
}
