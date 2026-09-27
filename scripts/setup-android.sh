#!/usr/bin/env bash
# Creates the native Android project for HomeBoard.
#
# The APK carries its own copy of the web app and loads it from https://localhost,
# so it never shows the host's "waking up" page. It only needs to know where the
# API lives — pass that as the first argument.
#
#   ./scripts/setup-android.sh https://homeboard.onrender.com
#
# Or let the GitHub Action in .github/workflows/android.yml do the whole thing
# in the cloud, with no Android Studio installed.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_URL="${1:-}"
if [ -z "$APP_URL" ]; then
  echo "Usage: $0 https://your-homeboard-url"
  echo "  (the live server the app should talk to)"
  exit 1
fi
case "$APP_URL" in
  https://*) ;;
  *) echo "The URL must start with https:// — Android blocks plain HTTP."; exit 1 ;;
esac
APP_URL="${APP_URL%/}"

echo "==> Checking $APP_URL/api/health"
if ! curl -fsS --max-time 90 "$APP_URL/api/health" | grep -q '"app":"HomeBoard"'; then
  echo "!! That URL did not answer as a HomeBoard server."
  echo "   Check it is deployed, then try again."
  exit 1
fi
echo

echo "==> Pointing the app at $APP_URL"
cat > public/config.js <<CONFIG
/* Written by scripts/setup-android.sh. Do not edit. */
window.HOMEBOARD_API = "$APP_URL";
CONFIG

echo "==> Installing Capacitor"
npm install --no-save @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 @capacitor/assets@3

echo "==> Creating the android/ project"
[ -d android ] || npx cap add android

echo "==> Generating launcher icons and splash screens"
npx @capacitor/assets generate --android --assetPath resources

echo "==> Syncing web assets"
npx cap sync android

cat <<'DONE'

Done. Next:
  npx cap open android      # opens Android Studio
  cd android && ./gradlew assembleDebug
  # APK lands at android/app/build/outputs/apk/debug/app-debug.apk

Remember to reset public/config.js back to an empty string before you commit,
or the web version will start calling the API cross-origin for no reason:
  git checkout public/config.js
DONE
