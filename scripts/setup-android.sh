#!/usr/bin/env bash
# Creates the native Android project for HomeBoard.
# Run once locally (needs Android Studio installed), or let the
# GitHub Action in .github/workflows/android.yml do it in the cloud.
set -euo pipefail

cd "$(dirname "$0")/.."

if grep -q "REPLACE-WITH-YOUR-RENDER-URL" capacitor.config.json; then
  echo "!! Edit capacitor.config.json first and put your live Render URL in \"server.url\"."
  echo "   The Android app is a shell around that URL — it needs to know where the server is."
  exit 1
fi

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
DONE
