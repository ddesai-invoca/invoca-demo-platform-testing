#!/usr/bin/env bash
# STEP 3. After YOU have reviewed and approved: push staging into the team's main (ddesai-invoca).
# The Render sandbox rebuilds from main. Verify with: npm run check-deploy
set -euo pipefail
branch="$(git branch --show-current)"
if [[ "$branch" != "staging" ]]; then echo "Run this from 'staging' (npm run start-work)."; exit 1; fi
if ! git diff --quiet || ! git diff --cached --quiet; then echo "Commit your changes first."; exit 1; fi
git fetch origin
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "main has new commits you do not have. Run: npm run push-staging  (it merges main), test again, then promote."; exit 1
fi
echo "→ Checks"; npm run typecheck; npm run build >/dev/null
echo
echo "This will update ddesai-invoca's main (what the team shares and the sandbox deploys):"
git log --oneline origin/main..HEAD | head -15
echo
read -r -p "Type YES to push to main: " ans
if [[ "$ans" != "YES" ]]; then echo "Cancelled. Nothing was pushed."; exit 1; fi
git push origin staging:main
git push fork staging 2>/dev/null || true
echo
echo "Pushed. Render rebuilds in a few minutes. Check it:  npm run check-deploy"
echo "Final review link: https://invoca-demo-platform-testing.onrender.com/"
