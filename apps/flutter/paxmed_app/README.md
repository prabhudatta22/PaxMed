# PaxMed — Flutter (`paxmed_app`)

Native shells for **Google Play** and the **Apple App Store**, using this repo’s existing Node.js API (`/api/*`).

## Setup

Install [Flutter stable](https://docs.flutter.dev/get-started/install) (includes Dart).

### macOS — iOS (Xcode)

Flutter needs the **full Xcode app**, not only “Command Line Tools”, so it can run `xcodebuild -list` and resolve `$(PRODUCT_BUNDLE_IDENTIFIER)` in `Info.plist`.

1. Install **Xcode** from the Mac App Store and open it once (install components).
2. Point the developer directory at Xcode (adjust the path if Xcode lives elsewhere):

   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```

3. Install **CocoaPods** (pick one): `brew install cocoapods` or `sudo gem install cocoapods`.
4. Install iOS pods **after** `flutter pub get`:

   ```bash
   cd apps/flutter/paxmed_app
   flutter pub get
   cd ios && pod install && cd ..
   ```

Use **`ios/Runner.xcworkspace`** in Xcode (not `Runner.xcodeproj`) once Pods exist.

### Android SDK

Install **Android Studio** (or Android SDK command-line tools), accept SDK licenses, then either rely on Android Studio’s default SDK path or tell Flutter explicitly:

```bash
flutter config --android-sdk "$HOME/Library/Android/sdk"
```

Set **`ANDROID_HOME`** (or **`ANDROID_SDK_ROOT`**) to that same directory in your shell profile.

### Project deps

```bash
cd apps/flutter/paxmed_app
flutter pub get
flutter doctor -v
```

Ensure the backend is reachable (default dev: port `3000`).

Run:

```bash
flutter run
```

### Troubleshooting

- **`Application not configured for iOS`** — Usually **`xcode-select`** still points at Command Line Tools. Run the `sudo xcode-select -s …` step above, then `flutter doctor`.
- **`pod: command not found`** — Install CocoaPods, then `cd ios && pod install`.
- **`No Android SDK found`** — Install the SDK and set `ANDROID_HOME` / `flutter config --android-sdk`.
- **Gradle fails with SDK / `sdk.dir` errors** — `android/local.properties` is gitignored and machine-specific. If it contains a path from another machine or OS (for example **`/opt/android-sdk-linux` on a Mac**), remove or fix the `sdk.dir=` line so it matches **`$HOME/Library/Android/sdk`** (or your real SDK path), then run `flutter doctor -v`.

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
