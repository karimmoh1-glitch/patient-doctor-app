#!/usr/bin/env bash
# Rehearses the release's intermediate states on a LOCAL scratch database with synthetic data only, running the REAL servers:
#   A  new code on the OLD schema (production's today)   -> must refuse to serve, not serve unsafely
#   B  OLD code (704b7df) on the NEW schema, before and after the signing key exists -> must fail closed, never expose data
#   C  new code on the new schema, key registered, enforcement on, unrestricted server scope refused -> serves
#   R  the rollback chain, newest first, then old code on the old structure -> serves again
# and times each migration. It touches only the scratch database avela_rehearsal_test. Output holds counts, statuses and timings only.
#
#   ops/release-rehearsal.sh [postgres-admin-url]
set -uo pipefail
ADMIN="${1:-postgres://localhost:5432/postgres}"
DB=avela_rehearsal_test
base="${ADMIN%/*}"
OWNER="$base/$DB"
here="$(cd "$(dirname "$0")/.." && pwd)"
OLD_SHA="${OLD_SHA:-704b7df34919ed330a82b85ac209707b42e6dcef}"
oldtree="$(mktemp -d -t avela-old.XXXXXX)"
log="$(mktemp -t avela-rehearse-log.XXXXXX)"
pids=()
cleanup() { for p in 5181 5182 5183 5184 5185; do k=$(lsof -ti tcp:$p 2>/dev/null); [ -n "$k" ] && kill $k 2>/dev/null; done; for p in "${pids[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; sleep 1; git -C "$here" worktree remove --force "$oldtree" >/dev/null 2>&1; psql "$ADMIN" -qAt -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1; rm -f "$log"; }
trap cleanup EXIT
fail=0
check() { if [ "$2" = "$3" ]; then printf 'PASS  %s (%s)\n' "$1" "$3"; else printf 'FAIL  %s: expected %s, got %s\n' "$1" "$2" "$3"; fail=1; fi; }
step() { printf '\n== %s\n' "$1"; }
q() { psql "$OWNER" -qAt -c "$1"; }
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

psql "$ADMIN" -qAt -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB" >/dev/null || { echo "cannot create scratch database"; exit 1; }
step "0. Production's state: migrations 0000-0023 on a scratch database, one synthetic patient and one synthetic clinician"
tmp=$(mktemp -d); for f in "$here"/migrations/*.sql; do n=$(basename "$f"); [[ "$n" < "0024" ]] && cp "$f" "$tmp/"; done
(cd "$here" && DATABASE_URL="$OWNER" npx tsx -e "import { runMigrations } from './script/migrate'; runMigrations(process.env.DATABASE_URL!, '$tmp').then(() => process.exit(0))" >/dev/null 2>&1)
check "migrations applied" "24" "$(q 'SELECT count(*) FROM schema_migrations')"
HASH=$(cd "$here" && node -e 'console.log(require("bcryptjs").hashSync("Rehearsal-Passphrase-1", 4))')
q "INSERT INTO users (id, name, email, password_hash, role, state) VALUES ('u-patient', 'Rehearsal Patient', 'patient@rehearsal.example', '$HASH', 'patient', 'CA'), ('u-doc', 'Rehearsal Doctor', 'doc@rehearsal.example', '$HASH', 'doctor', 'CA')" >/dev/null
q "INSERT INTO doctor_profiles (id, user_id, name, specialty, state, license_number, phone, active, source, timezone, languages, modalities, verified_at) VALUES ('dp-1', 'u-doc', 'Rehearsal Doctor', 'Cardiology', 'CA', 'X1', '+15550001111', true, 'application', 'America/Los_Angeles', ARRAY['en'], ARRAY['phone'], now())" >/dev/null 2>&1
ROLEURL="${OWNER}?options=-c%20role%3Davela_app"

start() { # start <name> <dir> <port> [extra env...] ; the server runs as the restricted role with enforcement on, as in production
  local name=$1 dir=$2 port=$3; shift 3
  (cd "$dir" && env NODE_ENV=development PORT=$port DATABASE_URL="$OWNER" APP_DATABASE_URL="$ROLEURL" DB_ENFORCE_RLS=on JWT_SECRET=rehearsal-only E2E_DISABLE_RATE_LIMITS=true MFA_ENCRYPTION_KEY=$(openssl rand -base64 32) "$@" npx tsx server/index.ts >"$log.$name" 2>&1 &) ; sleep 0.2
  pids+=("$(lsof -ti tcp:$port 2>/dev/null | head -1)")
}
waitfor() { for _ in $(seq 1 90); do curl -s -o /dev/null "http://127.0.0.1:$1/api/health" && return 0; sleep 1; done; return 1; }
stop_port() { local p; p=$(lsof -ti tcp:$1 2>/dev/null); [ -n "$p" ] && kill $p 2>/dev/null; sleep 1; }
code() { curl -s -o /tmp/rehearsal-body -w '%{http_code}' "$@"; }
login() { code -X POST "http://127.0.0.1:$1/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"patient@rehearsal.example","password":"Rehearsal-Passphrase-1"}'; }

step "A. NEW code on the OLD schema (what happens if the application is deployed before the migrations)"
start newA "$here" 5181
if waitfor 5181; then
  a=$(login 5181); check "sign-in is refused (not served) by the new code on the old schema" "500" "$a"
  check "no session token in the answer" "0" "$(grep -c 'token' /tmp/rehearsal-body)"
  check "the server says why (log)" "1" "$(grep -c "does not recognise\|identity" "$log.newA" | head -1 | awk '{print ($1>0)?1:0}')"
else echo "FAIL  new code did not start"; fail=1; fi
stop_port 5181

step "B. OLD code (704b7df) on the NEW schema (what happens to the live release between the migration and the new deploy)"
git -C "$here" worktree add --detach "$oldtree" "$OLD_SHA" >/dev/null 2>&1 && ln -s "$here/node_modules" "$oldtree/node_modules"
t0=$(ms); applied_total=0
for f in "$here"/migrations/00{24,25,26,27,28,29}_*.sql; do
  s=$(ms); (cd "$here" && DATABASE_URL="$OWNER" npx tsx -e "import { runMigrations } from './script/migrate'; import fs from 'fs'; import os from 'os'; import path from 'path'; const d = fs.mkdtempSync(path.join(os.tmpdir(), 'one-')); for (const x of fs.readdirSync('migrations').filter(n => n < '$(basename $f)')) fs.copyFileSync('migrations/' + x, path.join(d, x)); fs.copyFileSync('$f', path.join(d, '$(basename $f)')); runMigrations(process.env.DATABASE_URL!, d).then(() => process.exit(0))" >/dev/null 2>&1); e=$(ms)
  printf 'TIME  %s applied in %s ms\n' "$(basename $f)" "$((e-s))"
done
check "migrations recorded" "30" "$(q 'SELECT count(*) FROM schema_migrations')"
start oldB "$oldtree" 5182
if waitfor 5182; then
  b=$(login 5182); check "old code, new schema, enforcement on, no key: sign-in does not succeed" "1" "$([ "$b" != "200" ] && echo 1 || echo 0)"
  check "no token or private value in the answer" "0" "$(grep -c -E 'token|password_hash|@rehearsal' /tmp/rehearsal-body)"
  d=$(code "http://127.0.0.1:5182/api/doctors"); check "old code's public directory shows no clinician (fails closed)" "0" "$(grep -c 'Rehearsal Doctor' /tmp/rehearsal-body)"
else echo "FAIL  old code did not start"; fail=1; fi
stop_port 5182
q "UPDATE app_identity_config SET enforce = false" >/dev/null 2>&1
start oldB2 "$oldtree" 5183
if waitfor 5183; then
  b=$(login 5183); check "old code, new schema, enforcement OFF (roll-out state): still no sign-in" "1" "$([ "$b" != "200" ] && echo 1 || echo 0)"
  check "no token or private value in the answer" "0" "$(grep -c -E 'token|password_hash|@rehearsal' /tmp/rehearsal-body)"
fi
stop_port 5183

step "C. NEW code on the NEW schema: key registered, enforcement on, the unrestricted server scope refused"
# the rehearsal's signing key is the publicly known development key; a real release generates its own (docs/RELEASE_PROCEDURE.md §2)
(cd "$here" && DATABASE_URL="$OWNER" npx tsx -e "import { prepareLocalIdentity } from './script/lib/devIdentity'; prepareLocalIdentity(process.env.DATABASE_URL!).then(() => process.exit(0))" >/dev/null 2>&1)
(cd "$here" && DATABASE_URL="$OWNER" NODE_ENV=development npx tsx script/identity-keys.ts enforce on >/dev/null 2>&1)
s=$(ms); (cd "$here" && DATABASE_URL="$OWNER" NODE_ENV=development npx tsx script/identity-keys.ts enforce server-scope off >/dev/null 2>&1); e=$(ms)
check "server scope switched off" "f" "$(q 'SELECT allow_server_scope FROM app_identity_config')"
check "enforcement on" "t" "$(q 'SELECT enforce FROM app_identity_config')"
start newC "$here" 5184
if waitfor 5184; then
  c=$(login 5184); check "sign-in works" "200" "$c"
  check "the public directory answers (a clinician without a recorded licence check is not listed, by design)" "200" "$(code http://127.0.0.1:5184/api/doctors)"
  tok=$(curl -s -X POST http://127.0.0.1:5184/api/auth/login -H 'Content-Type: application/json' -d '{"email":"patient@rehearsal.example","password":"Rehearsal-Passphrase-1"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')
  check "an authenticated read of the person's own account works" "200" "$(code -H "Authorization: Bearer $tok" http://127.0.0.1:5184/api/auth/me)"
  check "and the response holds no password hash" "0" "$(grep -c -E 'password|\$2[aby]\$' /tmp/rehearsal-body)"
  check "readiness" "200" "$(code http://127.0.0.1:5184/api/health/ready)"
else echo "FAIL  new code did not start"; fail=1; fi
check "database audit" "1" "$(cd "$here" && DATABASE_URL="$OWNER" NODE_ENV=development npx tsx script/audit-database.ts 2>&1 | tail -1 | grep -c '0 finding')"
stop_port 5184

step "R. Rollback, newest first, then the OLD code on the old structure"
for f in 0030_bind_acting_person 0029_narrow_server_scope 0028_scoped_system_identity 0027_connection_end_semantics 0026_private_account_columns 0025_verified_identity 0024_close_rls_gaps; do
  s=$(ms); psql "$OWNER" -q -v ON_ERROR_STOP=1 -f "$here/ops/rollback/$f.down.sql" >/dev/null 2>&1; rc=$?; e=$(ms)
  printf 'TIME  rollback %s: %s ms (exit %s)\n' "$f" "$((e-s))" "$rc"; [ $rc -ne 0 ] && fail=1
done
check "migration records back to production's" "24" "$(q 'SELECT count(*) FROM schema_migrations')"
start oldR "$oldtree" 5185
if waitfor 5185; then
  r=$(login 5185); check "old code signs in on the restored structure" "200" "$r"
else echo "FAIL  old code did not start"; fail=1; fi
stop_port 5185

step "Result"
[ $fail -eq 0 ] && echo "PASS: every intermediate state fails closed or serves correctly; the rollback restores the old behaviour." || echo "FAIL: see above."
exit $fail
