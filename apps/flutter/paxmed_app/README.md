## PaxMed Flutter app

This folder contains the Flutter UI for PaxMed. It uses the existing Node/Express backend in this repo.

### 1) Install Flutter

Follow Flutter docs for macOS and ensure `flutter` is on your PATH.

### 2) Generate platform scaffolding (one-time)

From repo root:

```bash
cd apps/flutter/paxmed_app
flutter create .
flutter pub get
```

This generates `android/`, `ios/`, etc. (they are intentionally not checked in by the agent because Flutter tooling isn't available in the build environment).

### 3) Run backend

From repo root:

```bash
npm run dev
```

Backend defaults to `http://localhost:3000`.

### 4) Run the app

- **Android emulator**:
  - API base URL should be `http://10.0.2.2:3000` (default in app settings).
- **iOS simulator**:
  - Use `http://localhost:3000`.
- **Physical device**:
  - Use your laptop LAN IP (e.g. `http://192.168.1.10:3000`) and ensure phone + laptop are on same Wi‑Fi.

```bash
flutter run
```

### Features covered

- Live medicine search: `/api/online/compare?q=...` + `/api/compare/search?q=...&city=...`
- Use my location: device GPS → `/api/geocode/reverse?lat=&lng=` (server uses `GOOGLE_MAPS_API_KEY`)
- Cart + multi-checkout: add rows, open retailer/pharmacy links

