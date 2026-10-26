#!/usr/bin/env bash
# Generates fresh values for the secrets that are rotated by hand, into files only the current user can read. Prints file NAMES and
# the commands to use them, never a value. See docs/OPERATIONS_RUNBOOK.md, "Rotating secrets".
set -euo pipefail
umask 077
dir="${1:-$HOME/.avela-secrets/next-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$dir"
chmod 700 "$dir"
gen64() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-64; }
printf '%s' "$(gen64)" > "$dir/JWT_SECRET"
printf '%s' "$(gen64)" > "$dir/CRON_SECRET"
printf '%s' "$(gen64)" > "$dir/CRON_SECRET_CLOUDFLARE"
printf '%s' "$(gen64)" > "$dir/AVELA_RUNTIME_PASSWORD"
printf '%s' "$(openssl rand -base64 32 | tr -d '\n')" > "$dir/MFA_ENCRYPTION_KEY"
chmod 600 "$dir"/*
echo "Wrote new values (not shown) to $dir:"
ls -1 "$dir" | sed 's/^/  /'
cat <<TXT

Next, one secret at a time, in the order in the runbook. Setting a Vercel variable from a file keeps the value off the screen and out of shell history:
  npx vercel env rm JWT_SECRET production --scope <team> --yes
  npx vercel env add JWT_SECRET production --sensitive --scope <team> < "$dir/JWT_SECRET"
Keep the previous value until the new one is verified; delete this directory (rm -rf) once every secret is in the host and in your password manager.
TXT
