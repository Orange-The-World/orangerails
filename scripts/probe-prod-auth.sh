#!/usr/bin/env bash
#
# Does production auth answer, on the url and with the key the deployed app is
# actually carrying?
#
# WHAT A GREEN RUN PROVES
#   The auth service is reachable, the project url compiled into the deployed
#   bundle is right, and the publishable key compiled into that same bundle is
#   accepted by that service.
#
# WHAT A GREEN RUN DOES NOT PROVE, AND NEVER WILL
#   That a real customer can sign in. That needs a real account and a real
#   password, which is a separate and founder gated question. Do not quote a
#   green run here as evidence that sign-in works.
#
# WHERE THE KEY COMES FROM, AND WHY IT MATTERS
#   Out of the deployed bundle, not out of a stored variable. Build time
#   inlining means the javascript served to a browser is the only place the
#   truth lives. A stored copy of the correct key would keep this check green
#   while the deployed app carried a wrong one, which is precisely the failure
#   this was written to catch.
#
# HOW IT DECIDES
#   It POSTs a password grant for an address that has no account, with a random
#   password, and expects to be told the credentials are invalid. That answer
#   means "I am up, your key is good, that user does not exist", which is
#   exactly what we want to hear. Anything else is a failure, including a 200,
#   which would be far worse than a broken key.
#
# Exit 0 pass, 1 fail. Never silent: every failure names the host, the http
# status and what came back.

set -uo pipefail

UA="orangerails-ci-auth-probe"
PROBE_EMAIL="ci-auth-probe-no-such-account@orangerails.com"
KEY_OVERRIDE="${KEY_OVERRIDE-}"

# host to probe, and the pages.dev name for the same deployment as a fallback.
# The custom domain is the one a customer uses, so it is tried first. The
# fallback exists because an edge rule in front of the custom domain can refuse
# a datacentre address, and a probe that cannot be run is worse than one that
# names which door it came in by.
HOSTS=(
  "connect.orangerails.com|orangerails-prod.pages.dev"
  "app.orangerails.com|orangerails-app.pages.dev"
)

failures=0
checked=0

note() { echo "::notice::$*"; }
fail() { echo "::error::$*"; failures=$((failures + 1)); }

# Fetch a url, printing the body on stdout. Returns non-zero and prints nothing
# on any transport failure or non-200, so a caller cannot mistake an error page
# for content.
fetch() {
  local url="$1" body status
  body="$(curl -sS --max-time 25 --retry 2 --retry-delay 3 \
            -A "$UA" -w $'\n%{http_code}' "$url" 2>/dev/null)" || return 1
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$status" != "200" ]; then
    return 1
  fi
  printf '%s' "$body"
}

# A key is only safe to be in a browser bundle if its role claim says anon. A
# service role key inlined into a public artifact would be a serious incident,
# and nothing else in this repository is looking for one, so this is the place.
# Not every key is a jwt: the newer publishable format is opaque and carries no
# claims, so it is skipped rather than guessed at.
role_claim() {
  local key="$1" payload pad
  case "$key" in
    eyJ*) ;;
    *) printf 'not-a-jwt'; return 0 ;;
  esac
  payload="$(printf '%s' "$key" | cut -d. -f2 | tr '_-' '/+')"
  pad=$(( ${#payload} % 4 ))
  if [ "$pad" -ne 0 ]; then
    payload="${payload}$(printf '=%.0s' $(seq $((4 - pad))))"
  fi
  printf '%s' "$payload" | base64 -d 2>/dev/null | grep -oE '"role" *: *"[a-z_]+"' | head -1 | grep -oE '[a-z_]+"$' | tr -d '"'
}

probe_host() {
  local pair="$1" primary fallback host html assets asset js url key origin
  primary="${pair%%|*}"
  fallback="${pair##*|}"
  checked=$((checked + 1))

  html=""
  for host in "$primary" "$fallback"; do
    html="$(fetch "https://${host}/")" && { origin="$host"; break; }
    html=""
  done
  if [ -z "$html" ]; then
    fail "${primary}: could not fetch the page from either ${primary} or ${fallback}, so nothing was checked. This is a failure, not a skip."
    return
  fi
  if [ "$origin" != "$primary" ]; then
    note "${primary}: the custom domain did not answer this runner, so the same deployment was read from ${fallback} instead."
  fi

  mapfile -t assets < <(printf '%s' "$html" \
    | grep -oE '(src|href)="[^"]+\.js"' \
    | sed -E 's/^[a-z]+="//; s/"$//' \
    | sort -u)
  if [ "${#assets[@]}" -eq 0 ]; then
    fail "${primary}: the page references no javascript at all, so there is no bundle to read a key out of."
    return
  fi

  url=""
  key=""
  local looked=0
  for asset in "${assets[@]}"; do
    # A page can preload dozens of chunks and the value is in the first one or
    # two. Fetching all of them every hour to find it is waste, so stop after 25
    # and let the missing key below be the loud answer.
    if [ "$looked" -ge 25 ]; then
      break
    fi
    looked=$((looked + 1))
    case "$asset" in
      http*) ;;
      /*) asset="https://${origin}${asset}" ;;
      *) asset="https://${origin}/${asset}" ;;
    esac
    js="$(fetch "$asset")" || continue
    [ -n "$url" ] || url="$(printf '%s' "$js" | grep -oE 'https://[a-z]{20}\.supabase\.co' | head -1)"
    if [ -z "$key" ]; then
      key="$(printf '%s' "$js" | grep -oE 'sb_publishable_[A-Za-z0-9_-]{20,}' | head -1)"
    fi
    if [ -z "$key" ]; then
      key="$(printf '%s' "$js" | grep -oE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}' | head -1)"
    fi
    if [ -n "$url" ] && [ -n "$key" ]; then
      break
    fi
  done

  if [ -z "$url" ]; then
    fail "${primary}: no supabase project url is present in the deployed javascript. A build time value that did not make it into the artifact is exactly the defect this probe exists for."
    return
  fi
  if [ -z "$key" ]; then
    fail "${primary}: the deployed javascript carries the url ${url} but no publishable key, so a browser cannot authenticate against it."
    return
  fi

  local claim
  claim="$(role_claim "$key")"
  if [ "$claim" = "service_role" ]; then
    fail "${primary}: STOP. The key in the deployed browser bundle carries the service_role claim. That is a full access key served to every visitor and it must be rotated now."
    return
  fi
  if [ -z "$claim" ]; then
    note "${primary}: the key looks like a jwt but its payload would not decode, so the role claim could not be read. Said out loud rather than passed off as checked. The grant below is unaffected by it."
  elif [ "$claim" != "anon" ] && [ "$claim" != "not-a-jwt" ]; then
    fail "${primary}: the key in the deployed bundle carries the role claim '${claim}', which is neither anon nor the opaque publishable format. Refusing to guess whether that is safe."
    return
  fi

  if [ -n "$KEY_OVERRIDE" ]; then
    note "${primary}: KEY_OVERRIDE is set, so the deployed key is being IGNORED and a supplied value used instead. This run is a rehearsal of the failure path, not a verdict on production."
    key="$KEY_OVERRIDE"
  fi

  note "${primary}: url ${url}, key ${key:0:12}... (${#key} chars, role claim ${claim}). Posting a password grant for an address with no account."

  local password body status
  password="$(head -c 24 /dev/urandom | base64 | tr -d '\n')"
  body="$(curl -sS --max-time 25 \
            -A "$UA" \
            -X POST "${url}/auth/v1/token?grant_type=password" \
            -H "apikey: ${key}" \
            -H "Content-Type: application/json" \
            --data "{\"email\":\"${PROBE_EMAIL}\",\"password\":\"${password}\"}" \
            -w $'\n%{http_code}' 2>&1)"
  if [ $? -ne 0 ] && [ -z "$body" ]; then
    fail "${primary}: the request to ${url}/auth/v1/token did not complete at all. A transport failure is a failure, not an unknown."
    return
  fi
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  body="$(printf '%s' "$body" | tr -d '\n' | cut -c1-400)"

  case "$status" in
    400)
      case "$body" in
        *invalid_credentials*|*"Invalid login credentials"*|*invalid_grant*)
          note "${primary}: PASS. HTTP 400 invalid credentials, which is the service saying it is up, the key is good and that user does not exist."
          ;;
        *)
          fail "${primary}: HTTP 400 but not for invalid credentials, so the request was rejected for some other reason. Body: ${body}"
          ;;
      esac
      ;;
    422)
      note "${primary}: HTTP 422 from ${url}. The key was ACCEPTED, because a bad key is refused with 401 before the grant type is looked at, and the password grant itself is switched off on this project. That is a configuration choice, not a fault, and it still answers what this probe asks. Body: ${body}"
      ;;
    200)
      fail "${primary}: STOP AND ESCALATE. HTTP 200 to a random password on an address that has no account. Authentication is accepting something it must never accept."
      ;;
    401|403)
      fail "${primary}: HTTP ${status} from ${url}. The key the deployed app is carrying is missing, wrong or rotated, which is the original defect. Body: ${body}"
      ;;
    5*)
      fail "${primary}: HTTP ${status} from ${url}. The auth service is failing. Body: ${body}"
      ;;
    *)
      fail "${primary}: unexpected HTTP ${status} from ${url}. Body: ${body}"
      ;;
  esac
}

for pair in "${HOSTS[@]}"; do
  probe_host "$pair"
done

# A loop that finished is not a loop that did the work. If a host was skipped
# for any reason, say so and go red rather than report a clean sweep of nothing.
if [ "$checked" -ne "${#HOSTS[@]}" ]; then
  echo "::error::expected ${#HOSTS[@]} hosts, probed ${checked}. Not trusting this run."
  exit 1
fi

if [ "$failures" -ne 0 ]; then
  echo "Probed ${checked} host(s), ${failures} failed."
  exit 1
fi

echo "Probed ${checked} of ${#HOSTS[@]} host(s), all answered with invalid credentials as expected."
exit 0
