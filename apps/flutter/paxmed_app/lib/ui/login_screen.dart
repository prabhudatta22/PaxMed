import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api_binding.dart';
import '../state/auth_state.dart';

/// Stitch PaxMed Login — tokens from Tailwind theme excerpt.
abstract final class _LoginPalette {
  static const bg = Color(0xFFF7F9FB);
  static const onSurface = Color(0xFF191C1E);
  static const onSurfaceVariant = Color(0xFF3F4850);
  static const primary = Color(0xFF006194);
  static const primaryContainer = Color(0xFF007BB9);
  static const outline = Color(0xFF707881);
  static const outlineVariant = Color(0xFFBFC7D2);
  static const surfaceLow = Color(0xFFF2F4F6);
  static const surfaceLowest = Color(0xFFFFFFFF);
  static const successGreen = Color(0xFF16A34A);
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> with SingleTickerProviderStateMixin {
  final _phone = TextEditingController();
  final _otp = TextEditingController();
  final FocusNode _otpFocus = FocusNode();

  String? _err;
  bool _busy = false;
  bool _otpSent = false;

  late final AnimationController _fadeCtrl;
  late final Animation<double> _fadeAnimation;

  @override
  void initState() {
    super.initState();
    _fadeCtrl = AnimationController(vsync: this, duration: const Duration(milliseconds: 620));
    _fadeAnimation = CurvedAnimation(parent: _fadeCtrl, curve: Curves.easeOutCubic);
    _fadeCtrl.forward();
  }

  @override
  void dispose() {
    _fadeCtrl.dispose();
    _otpFocus.dispose();
    _phone.dispose();
    _otp.dispose();
    super.dispose();
  }

  String _compactPhone() => _phone.text.replaceAll(RegExp(r'\D'), '');

  Future<void> _continueWithGoogle() async {
    final binding = context.read<ApiBinding>();
    if (!binding.ready) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Connecting to PaxMed… try again shortly.')));
      return;
    }
    final uri = Uri.parse('${normalizeBaseUrl(binding.settings.baseUrl)}/api/auth/google/start');
    if (!kIsWeb) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Google sign-in is available on PaxMed Web. '
            'On mobile, verify with OTP below—a session stays in this app.',
          ),
        ),
      );
      return;
    }
    final ok = await launchUrl(uri, webOnlyWindowName: '_self');
    if (!ok && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Could not open Google login.')));
    }
  }

  Future<void> _request({bool resend = false}) async {
    final api = context.read<ApiBinding>().client;

    final compact = _compactPhone();
    if (compact.length != 10) {
      setState(() => _err = 'Enter a valid 10-digit Indian mobile number');
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final r = await api.postAuthRequestOtp(compact);
      final dev = r['dev_otp'];
      setState(() => _otpSent = true);
      WidgetsBinding.instance.addPostFrameCallback((_) => _otpFocus.requestFocus());
      if (mounted && dev != null) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Dev OTP: $dev')));
      } else if (mounted && resend) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('OTP resent')));
      }
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final api = context.read<ApiBinding>().client;
    final auth = context.read<AuthState>();
    final compact = _compactPhone();

    final code = _otp.text.trim();
    if (compact.length != 10) {
      setState(() => _err = 'Invalid phone.');
      return;
    }
    if (code.isEmpty || code.replaceAll(RegExp(r'\s'), '').isEmpty) {
      setState(() => _err = 'Enter the verification code.');
      return;
    }
    setState(() {
      _busy = true;
      _err = null;
    });
    try {
      final r = await api.postAuthVerifyOtp(phoneDigits: compact, code: code);
      final u = r['user'];
      if (u is Map<String, dynamic>) {
        auth.setUser(u);
      }
      await auth.refresh(context.read<ApiBinding>());
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _err = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _googleIcon() =>
      SizedBox(width: 20, height: 20, child: CustomPaint(painter: _GoogleMarkPainter()));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: _LoginPalette.bg,
      body: Stack(
        children: [
          const Positioned.fill(child: CustomPaint(painter: _VitalGridPainter())),
          const Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(color: Colors.transparent), child: _SoftGlow())),
          SafeArea(
            child: FadeTransition(
              opacity: _fadeAnimation,
              child: Align(
                alignment: Alignment.center,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 420),
                    child: Column(
                      children: [
                        if (Navigator.of(context).canPop())
                          Align(
                            alignment: Alignment.centerRight,
                            child: IconButton(
                              onPressed: () => Navigator.of(context).maybePop(),
                              icon: const Icon(Icons.close_rounded),
                              style: IconButton.styleFrom(
                                foregroundColor: _LoginPalette.onSurfaceVariant.withValues(alpha: 0.7),
                              ),
                            ),
                          )
                        else
                          const SizedBox(height: 8),
                        const SizedBox(height: 12),
                        _brandMark(),
                        const SizedBox(height: 36),
                        _glassLoginCard(context),
                        const SizedBox(height: 22),
                        _trustBadge(),
                        const SizedBox(height: 28),
                        Text(
                          kDebugMode
                              ? 'Dev: OTP flow matches web. Example +919100946364 with code 12345 when enabled on server.'
                              : 'OTP is encrypted in transit.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 11.5,
                            height: 1.35,
                            color: _LoginPalette.outline.withValues(alpha: 0.85),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _brandMark() => Column(
        children: [
          ShaderMask(
            blendMode: BlendMode.srcIn,
            shaderCallback: (bounds) => const LinearGradient(
              colors: [_LoginPalette.primary, _LoginPalette.primaryContainer],
            ).createShader(Rect.fromLTWH(0, 0, bounds.width < 160 ? 160 : bounds.width, 48)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: const [
                Icon(Icons.local_hospital_rounded, color: Colors.white, size: 52),
                SizedBox(width: 10),
                Text(
                  'PaxMed',
                  style: TextStyle(
                    fontSize: 40,
                    fontWeight: FontWeight.w800,
                    letterSpacing: -1.2,
                    color: Colors.white,
                    height: 1.05,
                  ),
                ),
              ],
            ),
          ),
          Text(
            'Care, clarity, and prescriptions',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: _LoginPalette.outline.withValues(alpha: 0.9),
              letterSpacing: 0.2,
            ),
          ),
        ],
      );

  /// Formats last 10 digits as `XXXXX XXXXX` for subtitle copy (Stitch `display-number`).
  String _displayPhoneGrouped(String compact10) {
    final d = compact10.replaceAll(RegExp(r'\D'), '');
    if (d.length != 10) return d.isEmpty ? '__________' : d;
    return '${d.substring(0, 5)} ${d.substring(5)}';
  }

  void _changeNumber() {
    setState(() {
      _otpSent = false;
      _otp.clear();
      _err = null;
    });
  }

  Widget _signupFooter(BuildContext context) => Center(
        child: Text.rich(
          TextSpan(
            style: TextStyle(fontSize: 14, height: 1.45, color: _LoginPalette.onSurfaceVariant, fontWeight: FontWeight.w500),
            children: [
              const TextSpan(text: 'New to PaxMed? '),
              WidgetSpan(
                alignment: PlaceholderAlignment.baseline,
                baseline: TextBaseline.alphabetic,
                child: GestureDetector(
                  onTap: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Use your mobile number—we’ll verify you by OTP.')),
                    );
                  },
                  child: const Text(
                    'Sign up',
                    style: TextStyle(color: _LoginPalette.primary, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),
        ),
      );

  Widget _entryLoginPhase(BuildContext context) {
    return Column(
      key: const ValueKey('entry'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Welcome back',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 28,
            height: 1.2,
            letterSpacing: -0.35,
            fontWeight: FontWeight.w700,
            color: _LoginPalette.onSurface,
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          'Sign in to access your clinical dashboard',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 14, height: 1.45, fontWeight: FontWeight.w500, color: _LoginPalette.onSurfaceVariant),
        ),
        const SizedBox(height: 26),
        _googleButton(context),
        const SizedBox(height: 22),
        _orDivider(),
        const SizedBox(height: 22),
        const Text(
          'Mobile Number',
          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: _LoginPalette.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _phone,
          keyboardType: TextInputType.phone,
          maxLength: 10,
          onChanged: (_) => setState(() => _err = null),
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
          decoration: InputDecoration(
            filled: true,
            fillColor: _LoginPalette.surfaceLowest,
            hintText: '99999 00000',
            counterText: '',
            prefixIconConstraints: const BoxConstraints(minWidth: 56),
            prefixIcon: Padding(
              padding: const EdgeInsets.only(left: 14, top: 16, bottom: 16),
              child: Align(
                widthFactor: 1,
                child: Text(
                  '+91',
                  style:
                      TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: _LoginPalette.onSurfaceVariant.withValues(alpha: 0.95)),
                ),
              ),
            ),
            contentPadding: const EdgeInsets.only(left: 0, right: 16, top: 16, bottom: 16),
            enabledBorder:
                OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide(color: _LoginPalette.outlineVariant)),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: _LoginPalette.primary.withValues(alpha: 0.85), width: 2),
            ),
          ),
        ),
        const SizedBox(height: 18),
        _gradientButton(onPressed: _busy ? null : _request, label: 'Send OTP', trailingIcon: Icons.arrow_forward_rounded),
      ],
    );
  }

  Widget _verifyOtpPhase(BuildContext context) {
    final phoneDisplay = _displayPhoneGrouped(_compactPhone());
    return Column(
      key: const ValueKey('verify'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Verify OTP',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 28,
            height: 1.2,
            letterSpacing: -0.35,
            fontWeight: FontWeight.w700,
            color: _LoginPalette.onSurface,
          ),
        ),
        const SizedBox(height: 10),
        Text.rich(
          textAlign: TextAlign.center,
          TextSpan(
            style: const TextStyle(fontSize: 14, height: 1.45, fontWeight: FontWeight.w500, color: _LoginPalette.onSurfaceVariant),
            children: [
              const TextSpan(text: 'Enter the 6-digit code sent to +91 '),
              TextSpan(
                text: phoneDisplay,
                style: TextStyle(color: _LoginPalette.onSurface.withValues(alpha: 0.94), fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
        const SizedBox(height: 26),
        const Text(
          'Enter Verification Code',
          style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: _LoginPalette.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _otp,
          focusNode: _otpFocus,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          maxLength: 6,
          onChanged: (_) => setState(() => _err = null),
          onSubmitted: (_) {
            if (!_busy) _verify();
          },
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 22, letterSpacing: 10, height: 1.1, fontWeight: FontWeight.w700, color: _LoginPalette.onSurface),
          decoration: InputDecoration(
            counterText: '',
            filled: true,
            fillColor: _LoginPalette.surfaceLowest,
            hintStyle: TextStyle(color: _LoginPalette.outlineVariant.withValues(alpha: 0.55), letterSpacing: 8, fontSize: 20),
            hintText: '••••••',
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: _LoginPalette.outlineVariant),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: _LoginPalette.primary.withValues(alpha: 0.85), width: 2),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            TextButton(
              style: TextButton.styleFrom(padding: EdgeInsets.zero, foregroundColor: _LoginPalette.primary),
              onPressed: _busy ? null : _changeNumber,
              child: const Text('Change Number', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            ),
            TextButton(
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                foregroundColor: _LoginPalette.onSurfaceVariant,
              ),
              onPressed: (_busy || _compactPhone().length != 10) ? null : () => _request(resend: true),
              child: Text('Resend OTP', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: _LoginPalette.onSurfaceVariant.withValues(alpha: 0.9))),
            ),
          ],
        ),
        const SizedBox(height: 8),
        _gradientButton(onPressed: _busy ? null : _verify, label: 'Verify & Login', trailingIcon: Icons.login_rounded),
      ],
    );
  }

  Widget _glassLoginCard(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 14, sigmaY: 14),
        child: Container(
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.86),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0x140F172A)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.06),
                blurRadius: 18,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          padding: const EdgeInsets.fromLTRB(24, 26, 24, 24),
          child: AbsorbPointer(
            absorbing: _busy,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 420),
                  switchInCurve: Curves.easeOutCubic,
                  switchOutCurve: Curves.easeInCubic,
                  transitionBuilder: (child, animation) {
                    final slide =
                        Tween<Offset>(begin: const Offset(0.065, 0), end: Offset.zero).animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic));
                    return FadeTransition(
                      opacity: animation,
                      child: SlideTransition(position: slide, child: child),
                    );
                  },
                  child: _otpSent ? _verifyOtpPhase(context) : _entryLoginPhase(context),
                ),
                if (_err != null) ...[
                  const SizedBox(height: 14),
                  Text(_err!, style: const TextStyle(color: Colors.redAccent, fontSize: 13, height: 1.35)),
                ],
                const SizedBox(height: 26),
                _signupFooter(context),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _googleButton(BuildContext context) {
    return Material(
      color: _LoginPalette.surfaceLowest,
      elevation: 0,
      shadowColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: BorderSide(color: _LoginPalette.outlineVariant)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        splashColor: _LoginPalette.primary.withValues(alpha: 0.08),
        onTap: _busy ? null : () => _continueWithGoogle(),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 15, horizontal: 18),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _googleIcon(),
              const SizedBox(width: 12),
              const Text(
                'Continue with Google',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: _LoginPalette.onSurface),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _orDivider() => Row(
        children: [
          Expanded(child: Divider(color: _LoginPalette.outlineVariant.withValues(alpha: 0.35), thickness: 1, height: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Text(
              'OR',
              style: TextStyle(
                fontSize: 11.5,
                letterSpacing: 2.8,
                fontWeight: FontWeight.w700,
                color: _LoginPalette.outline.withValues(alpha: 0.9),
              ),
            ),
          ),
          Expanded(child: Divider(color: _LoginPalette.outlineVariant.withValues(alpha: 0.35), thickness: 1, height: 1)),
        ],
      );

  Widget _trustBadge() => Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.verified_user_rounded, size: 19, color: _LoginPalette.successGreen.withValues(alpha: 0.85)),
          const SizedBox(width: 10),
          Text(
            'SECURE CLINICAL ACCESS',
            style: TextStyle(
              fontSize: 11,
              letterSpacing: 2.15,
              fontWeight: FontWeight.w700,
              color: _LoginPalette.onSurfaceVariant.withValues(alpha: 0.65),
            ),
          ),
        ],
      );

  Widget _gradientButton({VoidCallback? onPressed, required String label, IconData trailingIcon = Icons.arrow_forward_rounded}) {
    final inactive = _busy || onPressed == null;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        gradient: LinearGradient(colors: inactive ? [_LoginPalette.primary.withValues(alpha: 0.5), _LoginPalette.primaryContainer.withValues(alpha: 0.5)] : [_LoginPalette.primary, _LoginPalette.primaryContainer]),
        boxShadow: inactive
            ? null
            : [
                BoxShadow(
                  color: _LoginPalette.primary.withValues(alpha: 0.25),
                  blurRadius: 12,
                  offset: const Offset(0, 4),
                ),
              ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          splashColor: Colors.white24,
          highlightColor: Colors.white10,
          onTap: inactive ? null : onPressed,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: inactive && _busy
                ? Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: const [
                      SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white)),
                    ],
                  )
                : Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        label,
                        style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: Colors.white, letterSpacing: 0.1),
                      ),
                      const SizedBox(width: 8),
                      Icon(trailingIcon, color: Colors.white, size: 20),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// Grid like Tailwind `.vital-clarity-grid`, drawn at opacity in paint.
class _VitalGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final line = Paint()
      ..color = const Color(0xFFE2E8F0).withValues(alpha: 0.22)
      ..strokeWidth = 1;
    const step = 48.0;
    for (var x = 0.0; x <= size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), line);
    }
    for (var y = 0.0; y <= size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), line);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _SoftGlow extends StatelessWidget {
  const _SoftGlow();

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              radius: 0.55,
              center: const Alignment(-0.82, -0.65),
              colors: [_LoginPalette.primary.withValues(alpha: 0.082), Colors.transparent],
            ),
          ),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: RadialGradient(
              radius: 0.5,
              center: const Alignment(0.82, 0.82),
              colors: [const Color(0xFF2DD4BF).withValues(alpha: 0.1), Colors.transparent],
            ),
          ),
        ),
      ],
    );
  }
}

/// Approximate multi-color Google “G” marks (scaled).
class _GoogleMarkPainter extends CustomPainter {
  @override
  void paint(Canvas c, Size s) {
    final center = Offset(s.width / 2, s.height / 2);
    final rOuter = s.shortestSide / 2;
    final sweep = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = rOuter * 0.42
      ..strokeCap = StrokeCap.square
      ..shader = const SweepGradient(
        colors: [Color(0xFF4285F4), Color(0xFFEA4335), Color(0xFFFBBC05), Color(0xFF34A853), Color(0xFF4285F4)],
        stops: [0.0, 0.25, 0.5, 0.75, 1.0],
      ).createShader(Rect.fromCircle(center: center, radius: rOuter));
    c.drawArc(Rect.fromCircle(center: center, radius: rOuter * 0.68), -0.95 * 3.14159, 1.92 * 3.14159, false, sweep);
    final bar = Paint()
      ..color = const Color(0xFF4285F4)
      ..strokeWidth = s.height * 0.18
      ..strokeCap = StrokeCap.round;
    c.drawLine(Offset(s.width * 0.52, center.dy), Offset(s.width * 0.9, center.dy), bar);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
