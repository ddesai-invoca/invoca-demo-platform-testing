## What changed and why

<!-- One or two sentences. Link a ticket if there is one. -->

## Collaborating on this feature?

If more than one person is working on this feature, branch off the feature
branch (not `main`) for your sub-task and PR into it there. Merge the
feature branch into `main` as its own PR once the feature is done. Rebase/pull
the feature branch often to avoid one big conflict at the end.

## Checklist

- [ ] `npm run typecheck` and `npm run lint` pass locally (CI also runs these)
- [ ] Touched `src/data/generated/*.json`? Confirm it's the intended prospect's
      file and you're not clobbering someone else's in-flight edit to the same one
- [ ] `git status`/`git diff` reviewed — no `.env`, API keys, or other secrets
      in the diff
- [ ] Ran the relevant `npm run audit:*` script(s) if this touches generated
      demo data or a dashboard's schema
