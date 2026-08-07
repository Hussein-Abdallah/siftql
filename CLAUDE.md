# Working in this repository

`siftql` is a zero-dependency TypeScript query language: tokenizer, parser,
serializer, in-memory engine, and a linear-time regex matcher, all hand-written.

## Hard constraints

- **Zero runtime dependencies.** `dependencies` in `package.json` must stay empty.
  Anything the package needs at runtime gets written here, in `src/`.
- **Never run `npm publish`**, and never create a GitHub release. The package IS published, as `@siftql/core`, and a release now triggers a publish — `.github/workflows/release.yml` fires on `release: published` and pushes to the registry via OIDC. So `gh release create` is a publish, not a bookkeeping step. There is no exception to this, including when a task looks complete and the version number looks ready. Publishing is Hussein's action.
- **`/Users/sam/Desktop/Dev/CBSA` is read-only.** It is referenced only to compare
  behaviour against an existing app. Never edit, stage, or commit anything under it.
- Commit and push only when explicitly asked.

## Verifying a change

```
npm run typecheck && npm run lint && npm test && npm run build
```

The property harness lives in `test/properties.test.ts` and runs as part of
`npm test`. Increase its sample count with `SIFTQL_PROPERTY_RUNS=5000 npm test`.

## Releasing

The pipeline is proven — `0.1.1` went out through it — but the first two attempts failed, so:

- `npm version patch` rewrites `package.json` and **nothing else**. `VERSION` in `src/index.ts` is a separate literal, and a test asserts the two agree, so a bump that forgets it fails the build rather than shipping a constant that lies.
- Tag with `git tag -a`, not `git tag`. A lightweight tag is silently skipped by `git push --follow-tags`, and GitHub renders the commit message in place of release notes.
- The release workflow upgrades npm before publishing. Node 22 bundles npm 10, which implements `--provenance` but not the OIDC exchange trusted publishing needs — it signs the attestation and then uploads with no credential, and npm answers that with `404`, not `401`.
- Provenance records the source commit, so the tag must point at exactly what is published. Move the tag before republishing rather than publishing from a different commit.

## If you are an auditor or a review agent

Several agents often read this tree at the same time. Two rules keep them from
invalidating each other's work:

1. **Do not modify any file in this repository — not even temporarily.** No edits,
   no `git checkout`, no `git stash`, no staging, no new files. A file that changes
   under another agent's feet silently corrupts its results, and the agent that was
   reading it usually cannot tell.
2. **To test a modification, copy what you need out of the tree first.** Put it in
   `/tmp/<your-audit-id>/` and work on the copy. To compare against an earlier
   commit, use `git worktree add /tmp/<your-audit-id>/<ref> <ref>` — a worktree is
   a separate directory and does not disturb this one.

Report findings as: the file and line, a runnable repro, what it actually does,
and what it should do instead. A finding without a repro that someone else can run
is not yet a finding.

Verify before reporting that `git status --porcelain` is empty.

## Working agreement

Defects are fixed in named groups (G1, G2, …), with a full adversarial audit after
each group completes rather than after each individual fix. Every round so far has
found defects in the previous round's repairs, so the audit is not optional.

Two failure modes have cost the most time here, and are worth actively guarding
against:

- **Confirmatory tests.** A benchmark or property that exercises the one shape
  that cannot fail. The quadratic-walk benchmark used a string leaf, the only leaf
  type that never reached the quadratic branch, and the property built on it was
  blind to the same bug for two rounds.
- **Vacuous properties.** A property whose loop body stops executing — because the
  code it probes moved to a different hook — stays green and reports nothing.
  Assert that each property did a non-zero amount of meaningful work.

Comments that state a bound or a guarantee must be measured before they are
written. A substantial share of every audit's findings have been comments that
confidently described behaviour the code did not have.
