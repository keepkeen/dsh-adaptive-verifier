#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/keepkeen/dsh-adaptive-verifier.git"
INSTALL_DIR="${DSH_ADAPTIVE_VERIFIER_DIR:-$HOME/.local/share/dsh-adaptive-verifier}"
PROFILE="${1:-${DSH_PROFILE:-}}"

if [[ -z "$PROFILE" ]]; then
  cat >&2 <<'EOF'
Usage:
  bash scripts/install-local.sh <harness-profile>

Or set DSH_PROFILE first:
  export DSH_PROFILE=<harness-profile>
  bash scripts/install-local.sh
EOF
  exit 2
fi

for cmd in git npm dsh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command '$cmd' was not found in PATH" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$INSTALL_DIR")"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating existing checkout: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch origin main
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  if [[ -e "$INSTALL_DIR" ]]; then
    echo "error: $INSTALL_DIR exists but is not a git checkout" >&2
    exit 1
  fi
  echo "==> Cloning plugin to: $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Installing build dependencies"
cd "$INSTALL_DIR"
npm install --legacy-peer-deps

echo "==> Building plugin"
npm run build

echo "==> Installing bundle into Harness profile: $PROFILE"
dsh plugin --profile "$PROFILE" add "$INSTALL_DIR"

echo "==> Verifying composed Harness config"
DUMP_FILE="$(mktemp)"
trap 'rm -f "$DUMP_FILE"' EXIT

dsh --profile "$PROFILE" --dump-config >"$DUMP_FILE"

if ! grep -q 'adaptive-verifier' "$DUMP_FILE"; then
  echo "error: adaptive-verifier was not found in the composed Harness config" >&2
  echo "Inspect with: dsh --profile $PROFILE --dump-config" >&2
  exit 1
fi

cat <<EOF

Installed successfully.

Profile:     $PROFILE
Plugin path: $INSTALL_DIR

Default routing behavior:
  - Candidate generation inherits the provider/model selected by the current Harness agent.
  - The verifier backend is 'harness' by default and inherits the same current route.
  - No model mapping table is used.

Therefore, when Harness selects OpenCode Go DeepSeek Flash, verification uses that same selected route/model.
When Harness selects OpenCode Go DeepSeek Pro, verification follows the Pro route/model automatically.

Start Harness with:
  dsh --profile $PROFILE

Inspect configuration with:
  dsh --profile $PROFILE --dump-config
EOF
