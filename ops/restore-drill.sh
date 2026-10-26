#!/usr/bin/env bash
# Backup-and-restore rehearsal on a LOCAL PostgreSQL server, with synthetic data only.
#
#   ops/restore-drill.sh [postgres-admin-url]       (default: postgres://localhost:5432/postgres)
#
# What it proves: that a logical backup of an Avela database restores into an empty database with the same migration
# state, the same row counts, row-level security still switched on, the append-only triggers still present, and that
# the restricted runtime role can still read through the policies afterwards.
# What it does NOT prove: that the hosting provider's own backups (point-in-time recovery, branches) restore, how long
# THEIR restore takes, or that the provider's roles and settings come back. That drill is gate G07 and is run by the owner.
#
# It never touches any database other than the two scratch ones it creates and drops (avela_drill_src, avela_drill_restored).
set -euo pipefail

ADMIN_URL="${1:-postgres://localhost:5432/postgres}"
SRC=avela_drill_src
DST=avela_drill_restored
base="${ADMIN_URL%/*}"
src_url="$base/$SRC"
dst_url="$base/$DST"
dump="$(mktemp -t avela-drill.XXXXXX)"
here="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() { rm -f "$dump"; psql "$ADMIN_URL" -qAt -c "DROP DATABASE IF EXISTS $SRC" -c "DROP DATABASE IF EXISTS $DST" >/dev/null 2>&1 || true; }
trap cleanup EXIT
now() { date +%s; }
step() { printf '\n== %s\n' "$1"; }
q() { psql "$1" -qAt -c "$2"; }

step "1. Create a synthetic source database (migrations + fixture people; nothing real)"
cleanup
psql "$ADMIN_URL" -qAt -c "CREATE DATABASE $SRC" -c "CREATE DATABASE $DST" >/dev/null
( cd "$here" && DATABASE_URL="$src_url" NODE_ENV=development npm run -s db:migrate >/dev/null && DATABASE_URL="$src_url" NODE_ENV=development npm run -s db:seed >/dev/null )
src_migrations=$(q "$src_url" "SELECT count(*) FROM schema_migrations")
src_users=$(q "$src_url" "SELECT count(*) FROM users")
src_appts=$(q "$src_url" "SELECT count(*) FROM appointments")
src_rls=$(q "$src_url" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity")
src_triggers=$(q "$src_url" "SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public'")
echo "source: migrations=$src_migrations users=$src_users appointments=$src_appts rls_tables=$src_rls triggers=$src_triggers"

step "2. Take the backup (custom format, consistent snapshot)"
t0=$(now)
pg_dump --format=custom --file="$dump" "$src_url"
echo "backup: $(wc -c <"$dump" | tr -d ' ') bytes in $(( $(now) - t0 ))s"

step "3. Restore into the empty database"
t0=$(now)
pg_restore --no-owner --exit-on-error --dbname="$dst_url" "$dump"
restore_secs=$(( $(now) - t0 ))
echo "restore: ${restore_secs}s"

step "4. Compare"
fail=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then printf 'PASS  %s (%s)\n' "$1" "$3"; else printf 'FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi
}
check "migration records"        "$src_migrations" "$(q "$dst_url" "SELECT count(*) FROM schema_migrations")"
check "users"                    "$src_users"      "$(q "$dst_url" "SELECT count(*) FROM users")"
check "appointments"             "$src_appts"      "$(q "$dst_url" "SELECT count(*) FROM appointments")"
check "tables with RLS enabled"  "$src_rls"        "$(q "$dst_url" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity")"
check "append-only triggers"     "$src_triggers"   "$(q "$dst_url" "SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public'")"

step "5. Migrations are a no-op on the restored copy"
( cd "$here" && DATABASE_URL="$dst_url" NODE_ENV=development npm run -s db:migrate 2>&1 | tail -2 )
check "migration records after re-running" "$src_migrations" "$(q "$dst_url" "SELECT count(*) FROM schema_migrations")"

step "6. The restricted role sees nothing without an identity, and the right rows with one"
if q "$ADMIN_URL" "SELECT 1 FROM pg_roles WHERE rolname='avela_app'" | grep -q 1; then
  none=$(psql "$dst_url" -qAt -c "SET ROLE avela_app" -c "SELECT count(*) FROM appointments" | tail -1)
  check "avela_app, nobody signed in: appointments visible" "0" "$none"
  some=$(psql "$dst_url" -qAt -c "SET ROLE avela_app" -c "SET app.system = 'on'" -c "SELECT count(*) FROM appointments" | tail -1)
  check "avela_app, system context: appointments visible" "$src_appts" "$some"
else
  echo "SKIP  role avela_app does not exist in this cluster. NOTE: roles are NOT part of a logical backup; after a restore on a new server the operator must recreate the role and its login (npm run db:create-app-role) before switching the application over."
  fail=1
fi

step "Result"
if [ "$fail" -eq 0 ]; then echo "PASS: restore rehearsed on a local server (restore took ${restore_secs}s for a synthetic database). Provider drill still required."; else echo "FAIL: see the lines above."; exit 1; fi
