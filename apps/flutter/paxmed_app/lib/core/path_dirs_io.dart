import 'package:path_provider/path_provider.dart';

/// Directory path (with `.ml_cookies` segment) for [PersistCookieJar] on IO platforms.
Future<String> cookieJarStoragePath() async {
  final d = await getApplicationDocumentsDirectory();
  return '${d.path}/.ml_cookies';
}
