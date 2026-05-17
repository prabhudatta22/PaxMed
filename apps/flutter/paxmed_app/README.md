# PaxMed — Flutter (`paxmed_app`)

Native shells for **Google Play** and the **Apple App Store**, using this repo’s existing Node.js API (`/api/*`).

## Setup

Install [Flutter stable](https://docs.flutter.dev/get-started/install) (includes Dart). Once:

```bash
cd apps/flutter/paxmed_app
flutter pub get
```

Ensure the backend is reachable (default dev: port `3000`).

Run:

```bash
flutter run
```

**API base URL** is configurable in-app (Settings drawer). Emulator defaults vary by OS:

| Target | Typical base URL |
|--------|------------------|
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://localhost:3000` |
| Physical device | `http://<your-lan-ip>:3000` (same Wi‑Fi) |
| Production | Your HTTPS domain |

## Features (Dart client)

Medicine compare, labs, cart/checkout hand-off, orders, Razorpay, ABHA stubs, OTP/cookie-backed session (`dio` + persisted cookies).

See **`PUBLISHING.md`** for **Play Console** and **App Store Connect** release steps (signing IDs, bundles, versioning).

## Docker Flutter (optional)

Without a host Flutter SDK:

```bash
# from repo root
docker compose -f docker/flutter-env.yml run --rm flutter bash -lc "flutter pub get && flutter analyze"
docker compose -f docker/flutter-env.yml run --rm flutter bash -lc "flutter build apk --release"
docker compose -f docker/flutter-env.yml run --rm flutter bash -lc "flutter build ipa --no-codesign"
```

IPA still needs Apple codesigning on macOS/Xcode for submission.
