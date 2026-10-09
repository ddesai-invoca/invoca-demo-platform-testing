#!/usr/bin/env bash
# STEP 2. Save your work to your fork's `staging` branch. Test it locally with: npm run serve
set -euo pipefail
branch="$(git branch --show-current)"
if [[ "$branch" != "staging" ]]; then echo "You are on '${branch:-detached}'. Run: npm run start-work"; exit 1; fi
if ! git diff --quiet || ! git diff --cached --quiet; then echo "Commit your changes first (git add -A && git commit -m \"...\")."; exit 1; fi
git fetch origin
# Edits made to your fork's staging on github.com (e.g. in the browser) come in too.
git fetch fork 2>/dev/null || true
if git show-ref --verify --quiet refs/remotes/fork/staging; then
  git merge fork/staging -m "Merge fork staging" || { echo "Merge conflicts with fork/staging. Resolve, commit, run again."; exit 1; }
fi
echo "→ Bringing in the newest main"
if ! git merge origin/main -m "Merge main into staging"; then
  echo; echo "Merge conflicts. Resolve, commit, then run this again."; exit 1
fi
echo "→ Type check"; npm run typecheck
echo "→ Pushing to your fork's staging"
git push -u fork staging
echo
echo "Saved. Test it locally:  npm run serve   (http://localhost:3000)"
echo "When you approve it:     npm run promote"
