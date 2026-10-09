#!/usr/bin/env bash
# Is the deployed site running my latest commit?   npm run check-deploy [-- <base-url>]
url="${1:-https://invoca-demo-platform-testing.onrender.com}"
want="$(git rev-parse --short HEAD)"
got="$(curl -s -m 20 "$url/api/status" | python3 -c 'import sys,json;j=json.load(sys.stdin);print(j.get("commitShort") or "none", j.get("branch") or "-", j.get("environment") or "-")' 2>/dev/null || echo "unreachable")"
echo "this checkout: $want"; echo "deployed:      $got   ($url)"
[[ "$got" == "$want"* ]] && echo "✓ deployed" || echo "… not deployed yet (Render takes a few minutes), or a different commit is live."
