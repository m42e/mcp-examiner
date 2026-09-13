#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  setup-apple-signing-secrets.sh --cert <certificate.p12> --cert-password <password> \
    --identity <signing identity> [options]

Required:
  --cert <path>              Path to the exported Developer ID Application .p12 file.
  --cert-password <password> Password used when exporting the .p12 file.
  --identity <identity>      Full codesigning identity.

Optional:
  --apple-id <email>         Apple ID used for notarization.
  --app-password <password>  App-specific password for notarization.
  --team-id <team-id>        Apple Developer Team ID.
  --repo <owner/repo>        Repository for gh secret set.
  --set-gh-secrets           Upload the prepared values with GitHub CLI.
  --env-file <path>          Write KEY=VALUE lines to a local file.
  -h, --help                 Show this help text.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

base64_no_wrap() {
  base64 < "$CERT_PATH" | tr -d '\n'
}

write_value() {
  if [[ -n "$ENV_FILE" ]]; then
    printf '%s\n' "$1" >> "$ENV_FILE"
  else
    printf '%s\n' "$1"
  fi
}

upload_secret() {
  local name="$1"
  local value="$2"

  if [[ -n "$REPO" ]]; then
    gh secret set "$name" --repo "$REPO" --body "$value" >/dev/null
  else
    gh secret set "$name" --body "$value" >/dev/null
  fi
}

CERT_PATH=""
CERT_PASSWORD=""
SIGNING_IDENTITY=""
APPLE_ID=""
APP_PASSWORD=""
TEAM_ID=""
REPO=""
SET_GH_SECRETS=0
ENV_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cert)
      [[ $# -ge 2 ]] || fail "--cert requires a value"
      CERT_PATH="$2"
      shift 2
      ;;
    --cert-password)
      [[ $# -ge 2 ]] || fail "--cert-password requires a value"
      CERT_PASSWORD="$2"
      shift 2
      ;;
    --identity)
      [[ $# -ge 2 ]] || fail "--identity requires a value"
      SIGNING_IDENTITY="$2"
      shift 2
      ;;
    --apple-id)
      [[ $# -ge 2 ]] || fail "--apple-id requires a value"
      APPLE_ID="$2"
      shift 2
      ;;
    --app-password)
      [[ $# -ge 2 ]] || fail "--app-password requires a value"
      APP_PASSWORD="$2"
      shift 2
      ;;
    --team-id)
      [[ $# -ge 2 ]] || fail "--team-id requires a value"
      TEAM_ID="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || fail "--repo requires a value"
      REPO="$2"
      shift 2
      ;;
    --set-gh-secrets)
      SET_GH_SECRETS=1
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a value"
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CERT_PATH" ]] || fail "--cert is required"
[[ -f "$CERT_PATH" ]] || fail "certificate file not found: $CERT_PATH"
[[ -n "$CERT_PASSWORD" ]] || fail "--cert-password is required"
[[ -n "$SIGNING_IDENTITY" ]] || fail "--identity is required"

need_cmd base64

if [[ "$SET_GH_SECRETS" -eq 1 ]]; then
  need_cmd gh
fi

has_notarization=0
if [[ -n "$APPLE_ID" || -n "$APP_PASSWORD" || -n "$TEAM_ID" ]]; then
  [[ -n "$APPLE_ID" ]] || fail "--apple-id is required when notarization values are provided"
  [[ -n "$APP_PASSWORD" ]] || fail "--app-password is required when notarization values are provided"
  [[ -n "$TEAM_ID" ]] || fail "--team-id is required when notarization values are provided"
  has_notarization=1
fi

if [[ -n "$ENV_FILE" ]]; then
  : > "$ENV_FILE"
fi

cert_base64="$(base64_no_wrap)"

if [[ "$SET_GH_SECRETS" -eq 1 ]]; then
  upload_secret APPLE_CERT_BASE64 "$cert_base64"
  upload_secret APPLE_CERT_PASSWORD "$CERT_PASSWORD"
  upload_secret APPLE_SIGNING_IDENTITY "$SIGNING_IDENTITY"

  if [[ "$has_notarization" -eq 1 ]]; then
    upload_secret APPLE_ID "$APPLE_ID"
    upload_secret APPLE_APP_PASSWORD "$APP_PASSWORD"
    upload_secret APPLE_TEAM_ID "$TEAM_ID"
  fi

  printf 'Uploaded Apple signing secrets.\n'
  if [[ "$has_notarization" -eq 1 ]]; then
    printf 'Uploaded Apple notarization secrets.\n'
  else
    printf 'Skipped Apple notarization secrets because they were not provided.\n'
  fi
  exit 0
fi

write_value "APPLE_CERT_BASE64=$cert_base64"
write_value "APPLE_CERT_PASSWORD=$CERT_PASSWORD"
write_value "APPLE_SIGNING_IDENTITY=$SIGNING_IDENTITY"

if [[ "$has_notarization" -eq 1 ]]; then
  write_value "APPLE_ID=$APPLE_ID"
  write_value "APPLE_APP_PASSWORD=$APP_PASSWORD"
  write_value "APPLE_TEAM_ID=$TEAM_ID"
fi

if [[ -n "$ENV_FILE" ]]; then
  printf 'Wrote secrets to %s\n' "$ENV_FILE"
fi