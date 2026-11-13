#!/usr/bin/env bash
# Export Port66's NEAR Hackathon work into a standalone folder that can be
# pushed as its own public repository.
#
#   scripts/export-near-hackathon.sh <output-dir>
#
# Port66 itself is a private repository that predates the hackathon. Judges
# need to read and run the hackathon code, so this copies exactly that code,
# keeping Port66's folder layout so relative imports still resolve, plus:
#   - integration.diff: every change the hackathon made to pre-existing
#     Port66 files (payments, checkout window, discovery docs...)
#   - README.md, LICENSE and a root package.json for the runnable parts
#
# Nothing here reads secrets; .env files are never copied.
set -euo pipefail

OUT="${1:?usage: scripts/export-near-hackathon.sh <output-dir>}"
ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
# Last commit before any NEAR Intents work (feat/near-intents-checkout).
BASELINE="b8fd001"

if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "Refusing to write into non-empty $OUT" >&2
  exit 1
fi
mkdir -p "$OUT"
cd "$ROOT"

copy() { mkdir -p "$OUT/$(dirname "$1")"; cp "$1" "$OUT/$1"; }

# New code written for the hackathon, in full.
for f in $(git ls-files \
  apps/api/src/modules/near-intents \
  apps/api/scripts/near-intents-dry-run.ts \
  apps/buyer-agent \
  apps/web/src/components/marketplace/near-intents-pay-step.tsx \
  apps/web/src/lib/mcp \
  apps/web/src/app/api/mcp \
  apps/web/src/lib/x402/agent-proof.ts \
  scripts/export-near-hackathon.sh \
  docs/near-hackathon.md); do
  copy "$f"
done

# Changes to Port66 files that existed before the hackathon, as one diff.
git diff "$BASELINE" HEAD -- \
  apps/api/src/modules/payments \
  apps/api/src/app.module.ts \
  apps/api/vercel.json \
  apps/api/package.json \
  apps/api/.env.production.example \
  .env.example \
  pnpm-workspace.yaml \
  apps/web/src/components/marketplace/crypto-payment-modal.tsx \
  apps/web/src/components/marketplace/network-mark.tsx \
  apps/web/src/lib/api/client.ts \
  "apps/web/src/app/(account)/selling/selling-dashboard.tsx" \
  apps/web/src/app/llms.txt \
  apps/web/src/app/api/agent/v1 \
  apps/web/src/lib/muse/catalog.ts \
  > "$OUT/integration.diff"

cp docs/near-hackathon.md "$OUT/README.md"

cat > "$OUT/package.json" <<'JSON'
{
  "name": "port66-near-intents",
  "private": true,
  "description": "Port66's NEAR Intents checkout and buyer agent (NEAR Hackathon)",
  "scripts": {
    "dry-run": "tsx apps/api/scripts/near-intents-dry-run.ts",
    "agent": "pnpm --dir apps/buyer-agent agent",
    "test": "pnpm --dir apps/buyer-agent test"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "viem": "^2.52.0"
  }
}
JSON

cat > "$OUT/LICENSE" <<EOF
MIT License

Copyright (c) $(date +%Y) Port66

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
EOF

printf 'node_modules/\nreceipts.jsonl\nagent.config.json\n.env\n' > "$OUT/.gitignore"

echo "Exported to $OUT"
echo "Next: cd $OUT && git init && git add . && git commit -m 'Port66 x NEAR Intents' && push to a new public repo"
