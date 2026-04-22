# ai-agent-notify npm-Based Auto Release Design

Date: 2026-04-22
Status: Proposed
Scope: `packages/ai-agent-notify` release automation

## Goal

Make `@erica-s/ai-agent-notify` publish automatically when changes under `packages/ai-agent-notify/**` are pushed to `main`.

The published version must be derived only from the current npm version:

- Read the latest published npm version for `@erica-s/ai-agent-notify`
- Compute the next version as `published + 1 patch`
- Ignore any version already present in the repository
- Write the computed version back into the repository before publishing

The repository must remain the source of truth after the release completes, so the workflow must commit the computed version to git before running `npm publish`.

## Selected Approach

Keep a single workflow in `.github/workflows/publish-ai-agent-notify.yml` and extend the existing `publish` job.

This approach is selected because the repository already has release gating for:

- pushes to `main`
- stale `origin/main` detection
- release-commit skip logic
- tag collision prevention

Reusing the current workflow minimizes moving parts and keeps the release path easy to audit.

## Requirements

### Versioning

- The workflow must ignore `packages/ai-agent-notify/package.json` version when deciding what to publish.
- The workflow must query npm for the current published version.
- If npm returns `X.Y.Z`, the workflow must publish `X.Y.(Z+1)`.
- If npm has no published version, the workflow must publish `1.0.0`.
- The computed version is the only release version used for:
  - `package.json`
  - `package-lock.json`
  - npm publish
  - git tag
  - GitHub release title and notes

### Repository write-back

- Before publishing, the workflow must write the computed version into:
  - `packages/ai-agent-notify/package.json`
  - `packages/ai-agent-notify/package-lock.json`
- The workflow must create a release commit with this message format:
  - `chore(release): ai-agent-notify v<version> [skip publish]`
- The workflow must push that release commit back to `origin/main` before running `npm publish`.

### Trigger and loop control

- Normal pushes that touch `packages/ai-agent-notify/**` should still trigger the workflow.
- The workflow-generated release commit must not trigger another publish.
- Existing skip behavior based on:
  - `github-actions[bot]`
  - `[skip publish]`
  - release commit prefix
  must remain intact.

### Safety checks

- The workflow must continue to reject stale runs whose SHA no longer matches the latest `origin/main`.
- If the release commit cannot be pushed, the workflow must fail before `npm publish`.
- If the target tag already exists, the workflow must fail before `npm publish`.
- If npm publish fails after the release commit is pushed, the workflow may leave the bumped version committed in git. This is acceptable because it reflects the intended release version and preserves an auditable state.

## Workflow Design

### Plan job

The `plan` job remains the entry gate. It still decides whether the pipeline should run at all and whether the run is eligible to publish.

No version computation happens here.

### Test job

The Windows test job remains unchanged and continues to run against the commit that triggered the workflow.

This preserves the current quality gate without mixing release-state mutations into the test phase.

### Publish job

The `publish` job changes from "compare repository version with npm" to "derive next version from npm and apply it".

Sequence:

1. Checkout with full history.
2. Read the package name.
3. Query npm for the latest published version.
4. Compute the target version:
   - npm version exists: `published + 1 patch`
   - no npm version: `1.0.0`
5. Update `package.json` and `package-lock.json` to the target version.
6. Configure git author as `github-actions[bot]`.
7. Commit the version change using the release commit message.
8. Push the release commit to `origin/main`.
9. Re-fetch `origin/main` and verify the pushed commit is now the latest main tip.
10. Check that the release tag does not already exist.
11. Run `npm publish --provenance --access public`.
12. Create and push tag `ai-agent-notify-v<version>`.
13. Create or update the GitHub release.

## Implementation Notes

### Version update mechanism

Use `npm version <target> --no-git-tag-version` in `packages/ai-agent-notify`.

This updates both `package.json` and `package-lock.json` using npm's native behavior and avoids custom JSON editing logic in the workflow.

### Commit contents

Only the two version files should be included in the release commit:

- `packages/ai-agent-notify/package.json`
- `packages/ai-agent-notify/package-lock.json`

The workflow should stage only those paths before committing.

### Publish metadata

`prepublishOnly` already writes `.published` during packaging. No change is needed there.

## Tests

Add local tests for the release decision logic extracted into a small helper module or script-friendly function.

The tests must cover:

- published npm version `2.1.7` produces target `2.1.8`
- repository version is ignored when npm already has a version
- missing npm version produces `1.0.0`
- release commit messages still trip the skip logic

Existing package tests must still pass through:

- `node .\test\test-cli.js`

## Out of Scope

- automatic minor or major bumps
- release notes generated from commit history
- monorepo-wide shared release tooling
- publishing packages other than `@erica-s/ai-agent-notify`
