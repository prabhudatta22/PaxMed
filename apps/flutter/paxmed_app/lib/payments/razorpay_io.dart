import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:razorpay_flutter/razorpay_flutter.dart';

class RazorpayPayResult {
  const RazorpayPayResult({
    required this.orderId,
    required this.paymentId,
    required this.signature,
  });

  final String orderId;
  final String paymentId;
  final String signature;
}

Future<RazorpayPayResult?> collectDiagnosticsPayment({
  required String keyId,
  required String orderId,
  required int amountPaise,
  required String note,
}) async {
  if (kIsWeb || (!Platform.isAndroid && !Platform.isIOS)) return null;

  final c = Completer<RazorpayPayResult?>();
  final rz = Razorpay();

  rz.on(Razorpay.EVENT_PAYMENT_SUCCESS, (PaymentSuccessResponse rsp) {
    final out = RazorpayPayResult(
      orderId: rsp.orderId ?? orderId,
      paymentId: rsp.paymentId ?? '',
      signature: rsp.signature ?? '',
    );
    rz.clear();
    if (!c.isCompleted) c.complete(out);
  });

  rz.on(Razorpay.EVENT_PAYMENT_ERROR, (PaymentFailureResponse rsp) {
    rz.clear();
    if (!c.isCompleted) c.complete(null);
  });

  rz.on(Razorpay.EVENT_EXTERNAL_WALLET, (_) {
    rz.clear();
    if (!c.isCompleted) c.complete(null);
  });

  rz.open({
    'key': keyId,
    'amount': amountPaise,
    'currency': 'INR',
    'name': 'PaxMed',
    'order_id': orderId,
    'description': note,
  });

  return c.future;
}
