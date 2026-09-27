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

# Capacitor 6 generates a Gradle 8.2.1 project, and Gradle only runs on Java 21
# from 8.5 onwards. Catch the mismatch here rather than 40 lines into a build.
if command -v java >/dev/null 2>&1; then
  # Don't use `head -1` — some JVMs print a "Picked up JAVA_TOOL_OPTIONS" banner
  # before the version line. Match the version line itself.
  JAVA_MAJOR="$(java -version 2>&1 | grep -oE '(openjdk|java) version "[0-9]+' | grep -oE '[0-9]+$' | head -1)"
  if [ -n "$JAVA_MAJOR" ] && [ "$JAVA_MAJOR" -ge 21 ]; then
    echo "!! You are on Java $JAVA_MAJOR. Capacitor 6 builds on Gradle 8.2.1,"
    echo "   which does not run on Java 21 or newer. Use JDK 17:"
    echo "     export JAVA_HOME=/path/to/jdk-17"
    exit 1
  fi
fi

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

# A plain install pulls in the Capacitor packages from devDependencies. They
# have to be in package.json — the CLI discovers plugins by reading it, and a
# --no-save install leaves them invisible, producing an APK that cannot post
# a notification at all.
echo "==> Installing dependencies"
npm install --no-audit --no-fund

echo "==> Creating the android/ project"
[ -d android ] || npx cap add android

echo "==> Generating launcher icons and splash screens"
npx @capacitor/assets generate --android --assetPath resources

echo "==> Syncing web assets"
npx cap sync android

echo "==> Checking plugins and notification permissions"
node scripts/patch-android-manifest.js

cat <<'DONE'

Done. Next:
  npx cap open android      # opens Android Studio
  cd android && ./gradlew assembleDebug
  # APK lands at android/app/build/outputs/apk/debug/app-debug.apk

Remember to reset public/config.js back to an empty string before you commit,
or the web version will start calling the API cross-origin for no reason:
  git checkout public/config.js
DONE
