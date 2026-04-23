#!/usr/bin/env bash
# Build TalentAI extension ZIP + CRX for self-hosted distribution.
#
# PREREQ (one-time, on the server):
#   cd extension
#   openssl genrsa 2048 > extension-private.pem
#   # Add extension-private.pem, *.crx, dist/ to .gitignore
#
# Then on each release bump `version` in manifest.json and run this script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="${EXTENSION_RELEASES_DIR:-/opt/autonomous_agency/extension-releases}"
PRIVATE_KEY="$EXTENSION_DIR/extension-private.pem"

if [ ! -f "$PRIVATE_KEY" ]; then
  echo "ERROR: $PRIVATE_KEY not found." >&2
  echo "Generate it once with: openssl genrsa 2048 > $PRIVATE_KEY" >&2
  exit 1
fi

VERSION=$(grep '"version"' "$EXTENSION_DIR/manifest.json" | head -1 | awk -F'"' '{print $4}')
if [ -z "$VERSION" ]; then
  echo "ERROR: could not read version from manifest.json" >&2
  exit 1
fi

# Refuse to release if the placeholder key marker is still there.
if grep -q '__MUST_SET_KEY__' "$EXTENSION_DIR/manifest.json"; then
  echo "ERROR: manifest.json still contains __MUST_SET_KEY__." >&2
  echo "Generate the public key and paste it in as the \"key\" field first:" >&2
  echo "  openssl rsa -in $PRIVATE_KEY -pubout -outform DER 2>/dev/null | openssl base64 -A" >&2
  exit 1
fi

echo "Building TalentAI extension v${VERSION}"

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

# Copy only runtime files into the temp stage.
rsync -a \
  --exclude='.git*' \
  --exclude='scripts/' \
  --exclude='*.md' \
  --exclude='*.pem' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='test/' \
  --exclude='.DS_Store' \
  "$EXTENSION_DIR/" "$TEMP_DIR/"

mkdir -p "$RELEASE_DIR"

# --- ZIP (manual install for first-time users, Firefox, Edge) -----------------
ZIP_FILE="talentai-v${VERSION}.zip"
(cd "$TEMP_DIR" && zip -qr "$ZIP_FILE" . -x "*.pem")
mv "$TEMP_DIR/$ZIP_FILE" "$RELEASE_DIR/$ZIP_FILE"

# --- CRX (signed package for auto-updates on Chromium) -----------------------
if ! command -v crx3 >/dev/null 2>&1; then
  echo "Installing crx3..."
  npm install -g crx3
fi

CRX_FILE="talentai-v${VERSION}.crx"
crx3 "$TEMP_DIR" -o "$RELEASE_DIR/$CRX_FILE" -p "$PRIVATE_KEY"

# --- Compute extension ID from the private key ------------------------------
EXTENSION_ID=$(openssl rsa -in "$PRIVATE_KEY" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 \
  | xxd -p \
  | tr '0-9a-f' 'a-p')

SIZE_BYTES=$(wc -c < "$RELEASE_DIR/$ZIP_FILE" | tr -d ' ')
RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$RELEASE_DIR/latest.json" <<EOF
{
  "version": "$VERSION",
  "extensionId": "$EXTENSION_ID",
  "releasedAt": "$RELEASED_AT",
  "sizeBytes": $SIZE_BYTES,
  "releaseNotes": "v${VERSION} release"
}
EOF

echo
echo "Released v${VERSION}"
echo "  ZIP:          $RELEASE_DIR/$ZIP_FILE"
echo "  CRX:          $RELEASE_DIR/$CRX_FILE"
echo "  latest.json:  $RELEASE_DIR/latest.json"
echo "  Extension ID: $EXTENSION_ID"
echo
echo "Chrome/Edge will auto-update within ~5h."
echo "Force update immediately: open chrome://extensions and click Update."
