#!/bin/bash
# One-time: creates a local code-signing certificate "Klara Wisper Local" in your login keychain.
# Signing every build with the same certificate keeps the app's identity stable, so macOS keeps
# its permissions (microphone, system audio, accessibility…) across updates instead of asking again.
# The certificate is only used to sign this app on this Mac; it is not trusted for anything else.
set -euo pipefail
NAME="Klara Wisper Local"
if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "\"$NAME\" already exists"
  exit 0
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cfg" <<CFG
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CFG
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cfg" 2>/dev/null
PASS="$(/usr/bin/openssl rand -hex 16)"
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/id.p12" -passout "pass:$PASS" -name "$NAME"
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PASS" -T /usr/bin/codesign
# Check it really is usable for signing before saying so.
if security find-identity | grep -q "$NAME"; then
  echo "created \"$NAME\""
else
  echo "ERROR: the certificate was not added to the keychain" >&2
  exit 1
fi
