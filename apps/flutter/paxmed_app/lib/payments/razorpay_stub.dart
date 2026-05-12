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
}) async =>
    null;
