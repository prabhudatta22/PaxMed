import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../state/auth_state.dart';
import '../state/cart_state.dart';
import 'checkout_screen.dart';
import 'login_screen.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({super.key, this.embedded = false});

  final bool embedded;

  @override
  Widget build(BuildContext context) {
    final cart = context.watch<CartState>();
    final auth = context.watch<AuthState>();
    final items = cart.items;

    final grouped = <String, List<CartLine>>{};
    for (final line in items) {
      final key = line.source == CartSource.local
          ? 'local:${line.pharmacyId}'
          : line.source == CartSource.diagnostics
              ? 'diagnostics:${line.citySlug ?? 'unknown'}'
              : 'online:${line.onlineProviderId}';
      grouped.putIfAbsent(key, () => []).add(line);
    }

    Future<void> openUrls(List<String> urls) async {
      for (var i = 0; i < urls.length; i++) {
        final u = Uri.parse(urls[i]);
        unawaited(launchUrl(u, mode: LaunchMode.externalApplication));
        await Future<void>.delayed(const Duration(milliseconds: 450));
      }
    }

    List<String> uniqueUrls(Iterable<CartLine> lines) {
      final seen = <String>{};
      final out = <String>[];
      for (final l in lines) {
        final u = l.checkoutUrl;
        if (u.isEmpty) continue;
        if (seen.add(u)) out.add(u);
      }
      return out;
    }

    final checkoutCard = Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Multi-checkout', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Text(
              auth.isLoggedIn
                  ? 'Use PaxMed checkout for pharmacy home delivery (local pharmacy lines) and lab diagnostics bookings. External retailer links stay external.'
                  : 'Sign in with your phone OTP to place PaxMed-backed delivery / diagnostics orders.',
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: !auth.isLoggedIn
                  ? () {
                      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LoginScreen()));
                    }
                  : () {
                      Navigator.of(context).push(MaterialPageRoute<void>(
                        builder: (_) => const CheckoutScreen(),
                      ));
                    },
              child: Text(auth.isLoggedIn ? 'PaxMed checkout…' : 'Sign in & checkout'),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () async {
                final urls = uniqueUrls(items);
                if (urls.isEmpty) {
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Nothing to open')));
                  return;
                }
                await openUrls(urls);
              },
              icon: const Icon(Icons.open_in_new),
              label: const Text('Open external URLs (online / pharmacy maps)'),
            ),
          ],
        ),
      ),
    );

    final buckets = items.isEmpty
        ? const <Widget>[]
        : [
            for (final entry in grouped.entries) ...[
              _BucketCard(
                title: _bucketTitle(entry.value.first),
                source: entry.value.first.source,
                lines: entry.value,
                onOpenBucket: () async {
                  await openUrls(uniqueUrls(entry.value));
                },
              ),
              const SizedBox(height: 12),
            ]
          ];

    if (items.isEmpty) {
      bodyCore = Padding(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: Text(
            'Your cart is empty.\nBrowse medicines or labs to build a cart.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ),
      );
    } else {
      bodyCore = ListView(
        padding: const EdgeInsets.all(16),
        children: [
          checkoutCard,
          const SizedBox(height: 12),
          ...buckets,
        ],
      );
    }

    if (embedded) {
      return bodyCore;
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Cart'),
        actions: [
          if (items.isNotEmpty)
            TextButton(
              onPressed: () async {
                final ok = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Clear cart?'),
                    content: const Text('Remove all items from the cart?'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
                      FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Clear')),
                    ],
                  ),
                );
                if (ok == true) await cart.clear();
              },
              child: const Text('Clear'),
            ),
        ],
      ),
      body: bodyCore,
    );
  }
}

String _bucketTitle(CartLine line) {
  if (line.source == CartSource.local) return line.pharmacyName ?? 'Pharmacy';
  if (line.source == CartSource.diagnostics) {
    return line.pharmacyName ?? 'Diagnostics';
  }
  return line.onlineLabel ?? line.onlineProviderId ?? 'Online retailer';
}

class _BucketCard extends StatelessWidget {
  final String title;
  final CartSource source;
  final List<CartLine> lines;
  final VoidCallback onOpenBucket;

  const _BucketCard({
    required this.title,
    required this.source,
    required this.lines,
    required this.onOpenBucket,
  });

  @override
  Widget build(BuildContext context) {
    final cart = context.read<CartState>();
    var subtotal = 0.0;
    for (final l in lines) {
      subtotal += l.unitPriceInr * l.quantity;
    }

    final canOpen = lines.any((x) => x.checkoutUrl.isNotEmpty && source != CartSource.diagnostics);

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                ),
                TextButton(onPressed: canOpen ? onOpenBucket : null, child: const Text('Open links')),
              ],
            ),
            Text(
              'Source: ${source.name}',
              style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 8),
            for (final l in lines) ...[
              _LineRow(line: l, cart: cart),
              const Divider(height: 18),
            ],
            Align(
              alignment: Alignment.centerRight,
              child:
                  Text('Subtotal: ₹${subtotal.toStringAsFixed(2)}', style: const TextStyle(fontWeight: FontWeight.w700)),
            ),
          ],
        ),
      ),
    );
  }
}

class _LineRow extends StatelessWidget {
  final CartLine line;
  final CartState cart;

  const _LineRow({required this.line, required this.cart});

  @override
  Widget build(BuildContext context) {
    final diag = line.source == CartSource.diagnostics;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(line.medicineLabel, style: const TextStyle(fontWeight: FontWeight.w600)),
              if ((line.strength ?? '').trim().isNotEmpty)
                Text(line.strength!, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
              if (diag && (line.citySlug ?? '').trim().isNotEmpty)
                Text(
                  'City: ${line.citySlug}',
                  style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant),
                ),
              const SizedBox(height: 4),
              Text('₹${line.unitPriceInr.toStringAsFixed(2)} each', style: const TextStyle(fontSize: 12)),
            ],
          ),
        ),
        const SizedBox(width: 10),
        if (diag)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('x${line.quantity}', style: const TextStyle(fontWeight: FontWeight.w600)),
          )
        else
          SizedBox(
            width: 70,
            child: DropdownButtonFormField<int>(
              value: line.quantity,
              items: List.generate(10, (i) => i + 1)
                  .map((q) => DropdownMenuItem(value: q, child: Text('x$q')))
                  .toList(),
              onChanged: (v) {
                if (v != null) cart.setQty(line.lineId, v);
              },
            ),
          ),
        IconButton(onPressed: () => cart.remove(line.lineId), icon: const Icon(Icons.delete_outline)),
      ],
    );
  }
}
