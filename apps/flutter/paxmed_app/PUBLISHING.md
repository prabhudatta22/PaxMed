# Publishing PaxMed (Flutter) to Google Play & App Store

Identifiers in this repo:

| Platform | Identifier |
|---------|-------------|
| **Android** applicationId | `in.paxmed.paxmed_app` |
| **iOS** bundle ID | `in.paxmed.paxmedApp` |

Change these **before** shipping if another party already owns them in Play Console or App Store Connect.

---

## Prereqs

- Flutter stable (Dart SDK matches `pubspec.yaml`).
- **macOS / App Store**: Full **Xcode** from the App Store with developer dir set to it (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`). Command Line Tools alone are not enough for Flutter iOS builds.
- **CocoaPods**: install Pods before archiving — `cd apps/flutter/paxmed_app && flutter pub get && cd ios && pod install`; open **`Runner.xcworkspace`**.
- **Google Play**: Android SDK (Android Studio or cmdline-tools); `ANDROID_HOME` / `flutter config --android-sdk`.
- A **privacy policy URL** on HTTPS (required for listing; align text with actual data flows).

---

## Google Play

1. **Upload keystore** (back it up securely; losing it blocks updates):

   ```bash
   keytool -genkey -v -keystore upload-keystore.jks \
     -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Copy `android/key.properties.example` → `android/key.properties` with an **absolute** `storeFile` path. Confirm `android/key.properties` stays out of git (ignored).

3. **App bundle**:

   ```bash
   cd apps/flutter/paxmed_app
   flutter build appbundle
   ```

   Output: `build/app/outputs/bundle/release/app-release.aab`

4. In [Play Console](https://play.google.com/console), create the app with applicationId **`in.paxmed.paxmed_app`**, complete Data safety / content rating, upload the `.aab`, and enroll in **Play App Signing** when prompted.

---

## Apple App Store

1. Register bundle ID **`in.paxmed.paxmedApp`** in Apple Developer → Identifiers.

2. Open **`ios/Runner.xcworkspace`** in Xcode → Signing & Capabilities → your team.

3. Version **`pubspec.yaml`** (`version: x.y.z+build`); build number uses the suffix after `+`.

4. Build:

   ```bash
   cd apps/flutter/paxmed_app
   flutter build ipa
   ```

   Or Archive from Xcode and upload via Organizer / Transporter.

5. **`ITSAppUsesNonExemptEncryption`** is set to `false` — update only if you add custom encryption beyond standard HTTPS TLS.

---

## Regenerating platforms (optional)

Matching a specific Flutter revision without local Flutter install (from repo root):

```bash
docker compose -f docker/flutter-env.yml run --rm flutter bash -lc "flutter create . --org in.paxmed --project-name paxmed_app --platforms=android,ios"
```

(`docker/flutter-env.yml` sets `working_dir` to `apps/flutter/paxmed_app`.)

Re-apply PaxMed naming and permissions (`AndroidManifest.xml`, `Info.plist`) after regeneration.

---

## Backend URL

The app reads **API base URL** from Settings (persisted locally). Ship with production **HTTPS**. Ensure session cookies behave with your deployed server (Secure / SameSite) if cookie auth applies.
