#!/usr/bin/env bash
# STEP 1. Start (or resume) work: bring the latest main from the team repo into your `staging` branch.
#   npm run start-work
# Remotes: origin = ddesai-invoca (the team's final repo), fork = bmccarty322 (your fork).
set -euo pipefail
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have uncommitted changes. Commit or stash them first (git status shows them)."; exit 1
fi
git fetch origin
git fetch fork 2>/dev/null || true
if git show-ref --verify --quiet refs/heads/staging; then
  git checkout staging
elif git show-ref --verify --quiet refs/remotes/fork/staging; then
  git checkout -b staging --track fork/staging
else
  git checkout -b staging origin/main
fi
# Edits made to your fork's staging on github.com (e.g. in the browser) come in too.
git fetch fork 2>/dev/null || true
if git show-ref --verify --quiet refs/remotes/fork/staging; then
  git merge fork/staging -m "Merge fork staging" || { echo "Merge conflicts with fork/staging. Resolve, commit, run again."; exit 1; }
fi
echo "→ Merging the latest main (ddesai-invoca) into staging"
if ! git merge origin/main -m "Merge main into staging"; then
  echo; echo "Merge conflicts. Resolve the files git lists (ask Claude Code), then: git add -A && git commit"; exit 1
fi
echo
echo "On 'staging' at $(git rev-parse --short HEAD), up to date with main."
echo "Make changes with Claude Code, commit them, then:  npm run push-staging"
