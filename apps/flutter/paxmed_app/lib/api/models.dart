class City {
  final int id;
  final String name;
  final String state;
  final String slug;

  City({required this.id, required this.name, required this.state, required this.slug});

  factory City.fromJson(Map<String, dynamic> j) {
    return City(
      id: (j['id'] as num).toInt(),
      name: (j['name'] ?? '').toString(),
      state: (j['state'] ?? '').toString(),
      slug: (j['slug'] ?? '').toString(),
    );
  }
}

class LocalOffer {
  final int pharmacyId;
  final String pharmacyName;
  final String? chain;
  final String? addressLine;
  final String? pincode;
  final String cityName;
  final int medicineId;
  final String medicineLabel;
  final String? strength;
  final String? form;
  final int? packSize;
  final double priceInr;
  final double? mrpInr;
  final double? discountPct;
  final double? distanceKm;

  LocalOffer({
    required this.pharmacyId,
    required this.pharmacyName,
    required this.chain,
    required this.addressLine,
    required this.pincode,
    required this.cityName,
    required this.medicineId,
    required this.medicineLabel,
    required this.strength,
    required this.form,
    required this.packSize,
    required this.priceInr,
    required this.mrpInr,
    required this.discountPct,
    this.distanceKm,
  });

  factory LocalOffer.fromJson(Map<String, dynamic> j) {
    double? numOrNull(dynamic x) {
      if (x == null) return null;
      final n = double.tryParse(x.toString());
      return n;
    }

    final ps = j['pack_size'];

    return LocalOffer(
      pharmacyId: (j['pharmacy_id'] as num).toInt(),
      pharmacyName: (j['pharmacy_name'] ?? '').toString(),
      chain: j['chain']?.toString(),
      addressLine: j['address_line']?.toString(),
      pincode: j['pincode']?.toString(),
      cityName: (j['city_name'] ?? '').toString(),
      medicineId: (j['medicine_id'] as num).toInt(),
      medicineLabel: (j['display_name'] ?? '').toString(),
      strength: j['strength']?.toString(),
      form: j['form']?.toString(),
      packSize: ps == null ? null : int.tryParse(ps.toString()),
      priceInr: numOrNull(j['price_inr']) ?? 0,
      mrpInr: numOrNull(j['mrp_inr']),
      discountPct: numOrNull(j['discount_pct']),
      distanceKm: numOrNull(j['distance_km']),
    );
  }
}

class OnlineProviderQuote {
  final String providerId;
  final String label;
  final String? searchUrl;
  final String? website;
  final bool ok;
  final String? error;
  final String? dataMode;
  final double? priceInr;
  final double? mrpInr;
  final String? productTitle;

  OnlineProviderQuote({
    required this.providerId,
    required this.label,
    required this.searchUrl,
    required this.website,
    required this.ok,
    required this.error,
    required this.dataMode,
    required this.priceInr,
    required this.mrpInr,
    required this.productTitle,
  });

  factory OnlineProviderQuote.fromJson(Map<String, dynamic> j) {
    double? numOrNull(dynamic x) {
      if (x == null) return null;
      return double.tryParse(x.toString());
    }

    return OnlineProviderQuote(
      providerId: (j['provider_id'] ?? '').toString(),
      label: (j['label'] ?? j['provider_id'] ?? '').toString(),
      searchUrl: j['search_url']?.toString(),
      website: j['website']?.toString(),
      ok: j['ok'] == true,
      error: j['error']?.toString(),
      dataMode: j['data_mode']?.toString(),
      priceInr: numOrNull(j['price_inr']),
      mrpInr: numOrNull(j['mrp_inr']),
      productTitle: j['product_title']?.toString(),
    );
  }
}

class GeocodeResult {
  final String? formattedAddress;
  final String? locality;
  final String? state;
  final String? postalCode;
  final String? country;
  final String? placeId;
  final double? lat;
  final double? lng;
  final City? matchedCity;

  GeocodeResult({
    required this.formattedAddress,
    required this.locality,
    required this.state,
    required this.postalCode,
    required this.country,
    required this.placeId,
    required this.lat,
    required this.lng,
    required this.matchedCity,
  });

  factory GeocodeResult.fromJson(Map<String, dynamic> j) {
    final g = j['google'] as Map<String, dynamic>?;
    final mc = j['matched_city'] as Map<String, dynamic>?;
    return GeocodeResult(
      formattedAddress: g?['formatted_address']?.toString(),
      locality: g?['locality']?.toString(),
      state: g?['administrative_area_level_1']?.toString(),
      postalCode: g?['postal_code']?.toString(),
      country: g?['country']?.toString(),
      placeId: g?['place_id']?.toString(),
      lat: (g?['lat'] as num?)?.toDouble(),
      lng: (g?['lng'] as num?)?.toDouble(),
      matchedCity: mc == null ? null : City.fromJson(mc),
    );
  }
}

