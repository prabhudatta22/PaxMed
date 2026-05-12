import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_binding.dart';
import '../payments/razorpay_bridge.dart';
import '../state/auth_state.dart';
import '../state/cart_state.dart';
import 'login_screen.dart';

class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key});

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _delOpt = ValueNotifier<String>('normal');
  final _addr1 = TextEditingController();
  final _landmark = TextEditingController();
  final _addrCity = TextEditingController();
  final _addrPin = TextEditingController();

  final _patientName = TextEditingController();
  final _patientAge = TextEditingController(text: '30');
  final _patientGender = ValueNotifier<String>('other');
  final _patientEmail = TextEditingController();

  DateTime _diagSchedule = DateTime.now().add(const Duration(hours: 2));

  List<Map<String, dynamic>> _rx = [];
  List<Map<String, dynamic>> _addresses = [];

  String _paymentDiag = 'cod';
  int? _selectedAddrId;
  int? _prescriptionMedicineId;
  int? _prescriptionDiagId;

  final Map<String, TextEditingController> _doses = {};

  String? _msg;
  bool _busy = false;

  @override
  void dispose() {
    _delOpt.dispose();
    _patientGender.dispose();
    _addr1.dispose();
    _landmark.dispose();
    _addrCity.dispose();
    _addrPin.dispose();
    _patientName.dispose();
    _patientAge.dispose();
    _patientEmail.dispose();
    for (final x in _doses.values) {
      x.dispose();
    }
    super.dispose();
  }

  void _hydrateDosageControllers(List<CartLine> lines) {
    final ids = lines.map((e) => e.lineId).toSet();
    final remove = _doses.keys.where((k) => !ids.contains(k)).toList();
    for (final k in remove) {
      _doses.remove(k)?.dispose();
    }
    for (final ln in lines) {
      _doses.putIfAbsent(ln.lineId, TextEditingController.new);
    }
  }

  Future<void> _refreshData() async {
    final api = context.read<ApiBinding>().client;
    final auth = context.read<AuthState>();
    final cart = context.read<CartState>();

    final bundle = await api.getProfileBundle();
    final px = await api.listPrescriptions();

    Map<String, dynamic>? profMap;
    final prRaw = bundle['profile'];
    if (prRaw is Map<String, dynamic>) profMap = prRaw;

    final addrsRaw = bundle['addresses'] as List<dynamic>? ?? [];
    final pr = px['prescriptions'] as List<dynamic>? ?? [];

    Map<String, dynamic>? defAddr;
    for (final a in addrsRaw) {
      final m = Map<String, dynamic>.from(a as Map);
      if (m['is_default'] == true) defAddr = m;
    }
    defAddr ??= addrsRaw.isNotEmpty ? Map<String, dynamic>.from(addrsRaw.first as Map) : null;

    if (!mounted) return;

    _hydrateDosageControllers(cart.localLinesForDelivery().toList());

    setState(() {
      _addresses = addrsRaw.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      _rx = pr.map((e) => Map<String, dynamic>.from(e as Map)).toList();
      final defIdRaw = defAddr?['id'];
      final defParsed = defIdRaw is int ? defIdRaw : int.tryParse('${defIdRaw ?? ''}');
      _selectedAddrId ??= defParsed;

      if (_patientName.text.trim().isEmpty) {
        _patientName.text = (profMap?['full_name'] ?? auth.user?['full_name'] ?? '').toString();
      }
      if (_patientEmail.text.trim().isEmpty) {
        _patientEmail.text = (profMap?['email'] ?? '').toString();
      }
    });
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await _refreshData();
    });
  }

  Future<void> _pickDiagTime() async {
    final d = await showDatePicker(
      context: context,
      initialDate: _diagSchedule,
      firstDate: DateTime.now().add(const Duration(minutes: 12)),
      lastDate: DateTime.now().add(const Duration(days: 29)),
    );
    if (d == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_diagSchedule));
    if (t == null) return;
    setState(() {
      _diagSchedule = DateTime(d.year, d.month, d.day, t.hour, t.minute);
    });
  }

  Future<void> _placeMedicine(CartState cart) async {
    final lines = cart.localLinesForDelivery().toList();
    if (lines.isEmpty) {
      setState(() => _msg = 'No pharmacy items eligible for delivery in cart.');
      return;
    }
    if (_addr1.text.trim().isEmpty) {
      setState(() => _msg = 'Delivery address line 1 is required.');
      return;
    }

    final items = <Map<String, dynamic>>[];
    for (final ln in lines) {
      final doseCtrl = _doses[ln.lineId];
      final tablets = doseCtrl?.text.trim().isEmpty ?? true ? null : num.tryParse(doseCtrl!.text.trim());

      items.add({
        'source': 'local',
        'pharmacyId': ln.pharmacyId,
        'medicineId': ln.medicineId,
        'medicineLabel': ln.medicineLabel,
        'strength': ln.strength ?? '',
        'form': ln.form ?? '',
        'pack_size': ln.packSize,
        'quantity': ln.quantity,
        'unitPriceInr': ln.unitPriceInr,
        'mrpInr': ln.mrpInr,
        if (tablets != null) 'tablets_per_day': tablets,
      });
    }

    final body = <String, dynamic>{
      'delivery_option': _delOpt.value,
      'address': {
        'address_line1': _addr1.text.trim(),
        'landmark': _landmark.text.trim(),
        'city': _addrCity.text.trim(),
        'pincode': _addrPin.text.trim(),
      },
      'items': items,
      if (_prescriptionMedicineId != null) 'prescription_id': _prescriptionMedicineId,
    };

    final api = context.read<ApiBinding>().client;

    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await api.createMedicineOrder(body);
      await cart.removeLocalDeliveryEligible();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Pharmacy order placed')));
        Navigator.of(context).pop();
      }
    } catch (e) {
      setState(() => _msg = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _placeDiagnostics(CartState cart) async {
    final api = context.read<ApiBinding>().client;
    final auth = context.read<AuthState>();
    final lines = cart.diagnosticsLines().toList();
    if (lines.isEmpty) {
      setState(() => _msg = 'No diagnostics items in cart.');
      return;
    }

    Map<String, dynamic>? selected;
    for (final a in _addresses) {
      final id = (a['id'] as num).toInt();
      if (_selectedAddrId == id) selected = a;
    }
    if (selected == null || '${selected['pincode']}'.trim().isEmpty || '${selected['address_line1']}'.trim().isEmpty) {
      setState(() => _msg = 'Pick a saved address that includes pincode (Profile ▸ Addresses).');
      return;
    }

    double sumInr = 0;
    for (final ln in lines) {
      sumInr += ln.unitPriceInr * ln.quantity;
    }

    Map<String, dynamic>? rz;
    if (_paymentDiag == 'prepaid') {
      try {
        final st = await api.razorpayStatus();
        final configured = st['configured'] == true;
        if (!configured || st['key_id'] == null || '${st['key_id']}'.isEmpty) {
          setState(() => _msg = 'Prepaid needs Razorpay keys on server. Use COD or configure /payments/razorpay.');
          return;
        }
        final od = await api.razorpayCreateOrder(sumInr);
        final payer = await collectDiagnosticsPayment(
          keyId: od['key_id'] as String,
          orderId: od['order_id'] as String,
          amountPaise: (od['amount'] as num).toInt(),
          note: 'PaxMed diagnostics prepaid',
        );
        if (payer == null) {
          setState(() => _msg = 'Payment was not completed.');
          return;
        }
        rz = {
          'razorpay_order_id': payer.orderId,
          'razorpay_payment_id': payer.paymentId,
          'razorpay_signature': payer.signature,
        };
      } catch (e) {
        setState(() => _msg = e.toString());
        return;
      }
    }

    final packages = <Map<String, dynamic>>[];
    for (final ln in lines) {
      final pid = '${ln.packageId ?? ''}'.trim();
      final deal = '${ln.dealId ?? pid}'.trim().isEmpty ? pid : '${ln.dealId}'.trim();
      packages.add({
        'package_id': pid,
        'deal_id': deal.isEmpty ? pid : deal,
        'package_name': ln.medicineLabel,
        'city': (ln.citySlug ?? '').trim().toLowerCase(),
        'price_inr': ln.unitPriceInr * ln.quantity,
        'mrp_inr': ln.mrpInr != null ? ln.mrpInr! * ln.quantity : null,
      });
    }

    final payload = <String, dynamic>{
      if (packages.isNotEmpty && packages.first['city'] != null) 'city': packages.first['city'],
      'packages': packages,
      'scheduled_for': _diagSchedule.toUtc().toIso8601String(),
      'address_id': _selectedAddrId,
      'payment_type': _paymentDiag,
      'patient': {
        'name': _patientName.text.trim(),
        'phone': auth.phoneE164 ?? auth.user?['phone_e164'] ?? '',
        'age': int.tryParse(_patientAge.text.trim()) ?? 30,
        'gender': _patientGender.value,
        'email': _patientEmail.text.trim(),
      },
      if (_prescriptionDiagId != null) 'prescription_id': _prescriptionDiagId,
      if (rz != null) ...rz,
    };

    setState(() {
      _busy = true;
      _msg = null;
    });

    try {
      await api.createDiagnosticsOrder(payload);
      await cart.removeDiagnosticsLines();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Diagnostics booking created')));
        Navigator.of(context).pop();
      }
    } catch (e) {
      setState(() => _msg = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  DropdownButtonFormField<int?> buildRxChooser(int? selected, ValueChanged<int?> changed) {
    return DropdownButtonFormField<int?>(
      value: selected,
      decoration: const InputDecoration(labelText: 'Attach prescription PDF (optional)'),
      items: [
        const DropdownMenuItem<int?>(value: null, child: Text('None')),
        ..._rx.map(
          (p) => DropdownMenuItem<int?>(
            value: (p['id'] as num).toInt(),
            child: Text('Rx ${p['id']} · ${p['original_filename'] ?? p['mime_type']}'),
          ),
        ),
      ],
      onChanged: changed,
    );
  }

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();
    final auth = context.watch<AuthState>();
    if (!auth.isLoggedIn) {
      return Scaffold(
        appBar: AppBar(title: const Text('Checkout')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('You need an OTP-linked consumer session to place backend orders.'),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen())),
                child: const Text('Sign in'),
              ),
            ],
          ),
        ),
      );
    }

    final medLines = cart.localLinesForDelivery().toList();
    final diagLines = cart.diagnosticsLines().toList();
    _hydrateDosageControllers(medLines);
    final sessionPhone =
        '${auth.phoneE164 ?? auth.user?['phone_e164'] ?? ''}'.trim();

    return Scaffold(
      appBar: AppBar(title: const Text('PaxMed checkout')),
      body: AbsorbPointer(
        absorbing: _busy,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('Session', style: TextStyle(fontWeight: FontWeight.w700)),
                  Text(
                    sessionPhone.isEmpty ? 'Logged in' : 'Logged in · ${auth.user?['id'] ?? '?'} · $sessionPhone',
                  ),
                ]),
              ),
            ),
            const SizedBox(height: 12),
            if (medLines.isEmpty)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(
                    'No local pharmacy lines qualifying for backend delivery.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
                  ),
                ),
              )
            else ...[
              Text('Pharmacy delivery (${medLines.length} lines)', style: const TextStyle(fontWeight: FontWeight.w700)),
              ValueListenableBuilder<String>(
                  valueListenable: _delOpt,
                  builder: (_, v, __) {
                    return DropdownButtonFormField<String>(
                      value: v,
                      decoration: const InputDecoration(labelText: 'Delivery option'),
                      items: const [
                        DropdownMenuItem(value: 'express_60', child: Text('Express ~60 min (+₹49)')),
                        DropdownMenuItem(value: 'express_4_6', child: Text('Express 4–6h (+₹29)')),
                        DropdownMenuItem(value: 'same_day', child: Text('Same day (+₹19)')),
                        DropdownMenuItem(value: 'normal', child: Text('Normal')),
                      ],
                      onChanged: (nv) => _delOpt.value = nv ?? 'normal',
                    );
                  }),
              buildRxChooser(_prescriptionMedicineId, (v) => setState(() => _prescriptionMedicineId = v)),
              TextField(controller: _addr1, decoration: const InputDecoration(labelText: 'Address line 1 *')),
              TextField(controller: _landmark, decoration: const InputDecoration(labelText: 'Landmark')),
              TextField(controller: _addrCity, decoration: const InputDecoration(labelText: 'City')),
              TextField(controller: _addrPin, decoration: const InputDecoration(labelText: 'Pincode')),
              ...medLines.map(
                (ln) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(ln.medicineLabel),
                          subtitle: Text((ln.pharmacyName ?? '') + ' · qty ${ln.quantity}'),
                        ),
                      ),
                      SizedBox(
                        width: 110,
                        child: TextField(
                          controller: _doses[ln.lineId],
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          decoration: const InputDecoration(labelText: 'qty/day?', isDense: true),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              FilledButton(onPressed: _busy ? null : () => _placeMedicine(cart), child: const Text('Place pharmacy order')),
            ],
            const SizedBox(height: 20),
            if (diagLines.isEmpty)
              Text(
                'No diagnostics lines in cart.',
                style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
              )
            else ...[
              Text('Diagnostics (${diagLines.length})', style: const TextStyle(fontWeight: FontWeight.w700)),
              if (_addresses.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    'Diagnostics orders need a Profile address with pincode. Save one under Profile → Addresses.',
                    style: TextStyle(color: Theme.of(context).colorScheme.error),
                  ),
                )
              else
                DropdownButtonFormField<int?>(
                  value: _selectedAddrId,
                  decoration: const InputDecoration(labelText: 'Pickup address profile'),
                  items: _addresses
                      .map(
                        (a) => DropdownMenuItem<int?>(
                          value: (a['id'] as num).toInt(),
                          child: Text(
                            '${a['label'] ?? ''} · ${a['address_line1'] ?? ''}, PIN ${a['pincode'] ?? ''}',
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (v) => setState(() => _selectedAddrId = v),
                ),
              ListTile(
                title: Text('Schedule · ${_diagSchedule.toLocal()}'),
                trailing: IconButton(icon: const Icon(Icons.event), onPressed: _busy ? null : _pickDiagTime),
              ),
              TextField(controller: _patientName, decoration: const InputDecoration(labelText: 'Patient name *')),
              TextField(controller: _patientAge, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Age')),
              ValueListenableBuilder<String>(
                  valueListenable: _patientGender,
                  builder: (_, g, __) {
                    return DropdownButtonFormField<String>(
                      value: g,
                      decoration: const InputDecoration(labelText: 'Gender'),
                      items: const [
                        DropdownMenuItem(value: 'male', child: Text('Male')),
                        DropdownMenuItem(value: 'female', child: Text('Female')),
                        DropdownMenuItem(value: 'other', child: Text('Other')),
                      ],
                      onChanged: (v) => _patientGender.value = v ?? 'other',
                    );
                  }),
              TextField(controller: _patientEmail, decoration: const InputDecoration(labelText: 'Email (optional)')),
              ListTile(
                title: const Text('Phone'),
                subtitle: Text(sessionPhone.isEmpty ? '(unknown — reopen session)' : sessionPhone),
              ),
              DropdownButtonFormField<String>(
                value: _paymentDiag,
                decoration: const InputDecoration(labelText: 'Payment'),
                items: const [
                  DropdownMenuItem(value: 'cod', child: Text('Cash on sample collection')),
                  DropdownMenuItem(value: 'prepaid', child: Text('Prepaid (Razorpay mobile SDK)')),
                ],
                onChanged: (nv) => setState(() => _paymentDiag = nv ?? 'cod'),
              ),
              buildRxChooser(_prescriptionDiagId, (v) => setState(() => _prescriptionDiagId = v)),
              FilledButton.tonal(
                  onPressed: (_busy || _addresses.isEmpty) ? null : () => _placeDiagnostics(cart),
                  child: const Text('Book diagnostics')),
            ],
            if ((_msg ?? '').trim().isNotEmpty)
              Padding(padding: const EdgeInsets.only(top: 14), child: Text(_msg!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
            if (_busy) const LinearProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
