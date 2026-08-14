# Project Log - Gemini Video Watermark Cleaner

This file is the running execution log for the project. Every implementation change should increment the project version and record the corresponding branch, commits, validation, failures, fixes, and next action.

## 2026-08-14 - Research and v1.0.0 implementation

### Goal
Create an independent, local-first browser tool focused on removing the visible Gemini/Veo watermark overlay from user-owned or authorized video, based on research into two reference repositories:

- `ishara-madu/gemini-watermark-remover`
- `GargantuaX/gemini-watermark-remover`

### Research conclusions

- Retain the lightweight browser-first UX and local processing model seen in the Ishara project.
- Use the more modular detection/restoration/export ideas observed in GargantuaX rather than a monolithic implementation.
- Prefer inverse-alpha reconstruction over simple blur/inpaint as the primary cleanup method.
- Use multi-frame detection rather than trusting a single frame.
- Use known geometry priors for common Gemini/Veo layouts, then refine locally.
- Add spatial and gradient correlation, confidence gating, adaptive alpha, and per-frame skip logic.
- Keep ML/FDnCNN denoise out of the default v1 implementation because upstream work still treated it as experimental/review-scoped and because a browser-only deterministic baseline is easier to validate.
- Preserve the distinction between visible-overlay cleanup and invisible provenance systems such as SynthID; this project does not target invisible provenance.

### v1.0.0 implementation

Implemented:

- Browser-local video processing.
- MediaBunny/WebCodecs pipeline.
- 12-frame default watermark analysis.
- Known 1920x1080, 1280x720, 1080x1920, and 720x1280 geometry candidates.
- Projection of candidate geometry to other resolutions.
- Local position refinement around the best candidate.
- Spatial + gradient correlation scoring.
- Fail-closed minimum confidence threshold with explicit Force Cleanup override.
- Manual X/Y/size override.
- Inverse-alpha restoration.
- Alpha gain estimation and adaptive alpha correction.
- Per-frame confidence gate.
- Masked edge polish.
- Temporal correction stabilization.
- Scene-cut detection/reset so temporal state and alpha history do not carry across strong shot changes.
- MP4 AVC/H.264 output.
- Compatible encoded-audio passthrough.
- BT.709 color metadata.
- Web Worker processing.
- Progress and cancellation UI.
- Unit tests and CI workflow.
- Attribution and research documentation.

### Alpha profile strategy

- Added `scripts/sync-alpha-assets.mjs`.
- Script downloads the pinned alpha profile source from GargantuaX commit `a771bc28df7e6af97dd862d5f293157207ba6d58`.
- Extracts profiles `48`, `96`, and `96-20260520` and writes generated `src/vendor/alphaPayload.js` plus alpha source metadata.
- A procedural fallback template remains available if the sync step has not been run.

### Local validation before GitHub publication

- `npm run check`: PASS.
- `npm test`: PASS, 5/5 tests.
- Tests covered catalog geometry, 720p candidate variants, portrait bounds, synthetic multi-frame detection, and inverse-alpha reconstruction quality.
- Full dependency-backed Vite build was not completed in the source execution environment because outbound npm/raw GitHub networking timed out.

### GitHub publication

Repository:

- `dhvu1990/gemini-video-watermark-cleaner`
- Visibility at creation check: private.
- Default branch: `main`.

Because the repository was initially empty, `README.md` was used to initialize `main`.

Initial main commit:

- `fdcffb38d60deeef0c5752fd0e41cb63de647fa2` - `Initialize repository`

Source branch:

- `agent/v1.0.0`

The GitHub connector initially had to create files sequentially. These technical upload commits were subsequently squashed by creating a replacement commit from the final tree and force-moving the branch ref.

Clean v1.0.0 branch commit:

- `474fb632361ec8103bf7e691668f714373cd529b`

PR:

- PR #1
- Title: `feat: initial Gemini video watermark cleaner v1.0.0`
- Base: `main`
- Head: `agent/v1.0.0`
- Draft: yes
- 23 changed files
- 1,461 additions

## 2026-08-14 - CI failure investigation

### CI run

Workflow:

- `CI`
- Run ID: `31769559481`
- Job: `test-build`
- Job ID: `94672503929`
- Result: failure

### Failure point

The workflow failed in `actions/setup-node@v4` before dependency installation.

Observed error:

`Dependencies lock file is not found ... Supported file patterns: package-lock.json,npm-shrinkwrap.json,yarn.lock`

### Root cause

The CI configuration contained:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    cache: npm
```

`cache: npm` requires an npm/yarn lockfile, but this repository intentionally did not yet contain `package-lock.json`. Therefore setup-node aborted before `npm install`, alpha sync, syntax checks, unit tests, or production build could execute.

### Decision

Use the minimal low-risk fix for this stage: remove `cache: npm` instead of introducing a lockfile solely to satisfy setup-node. CI continues to use Node.js 22 and `npm install --no-audit --no-fund`.

The Actions log also emitted a warning that older action releases target deprecated Node.js 20 internally and are being forced onto Node.js 24 by the runner. This warning was not the failure cause.

## 2026-08-14 - v1.0.1 CI fix and project logging

Branch:

- `agent/v1.0.1`
- Based on clean v1.0.0 commit `474fb632361ec8103bf7e691668f714373cd529b`

Changes:

- Removed `cache: npm` from `.github/workflows/ci.yml`.
- Bumped package version from `1.0.0` to `1.0.1`.
- Updated `CHANGELOG.md` and `README.md`.
- Added this `PROJECT_LOG.md` as the permanent project execution log.

Commits created during the v1.0.1 branch work included:

- `edb13a7ea7da3b534045369b9d5b6220de24ab84` - `fix: remove npm cache requirement from CI`
- `dcc74abd7ef5ee9ecf6e6d7e232f26ed8f960bb9` - `chore: bump version to v1.0.1`
- `e39cd303d99bd762eca53799cbe948b06e9417d1` - `docs: record v1.0.1 changes`
- `20e6783e5997a930a5e95bfa3671b4e62c42d466` - added `PROJECT_LOG.md`
- `9c940b51d9ad3f37b50d111177a1b5fc86ec11ba` - final v1.0.1 branch head after README/version documentation update

PR #1 was closed without merge because its CI failure belonged to v1.0.0. A replacement PR was created for the corrected version:

- PR #2
- Title: `fix: stabilize CI and add project log v1.0.1`
- Base: `main`
- Head: `agent/v1.0.1`
- Head SHA before merge: `9c940b51d9ad3f37b50d111177a1b5fc86ec11ba`

### Successful CI verification for PR #2

Workflow:

- Name: `CI`
- Run ID: `31770108096`
- Run number: `32`
- Job: `test-build`
- Job ID: `94674059330`
- Result: SUCCESS

Verified successful steps:

1. Set up job - PASS
2. `actions/checkout@v4` - PASS
3. `actions/setup-node@v4` with Node.js 22 - PASS
4. `npm install --no-audit --no-fund` - PASS
5. `npm run setup:alpha` - PASS
6. `npm run check` - PASS
7. `npm test` - PASS
8. `npm run build` - PASS

This is the first fully dependency-backed production validation of the repository on GitHub infrastructure. It confirms the pinned alpha synchronization and Vite production build both work in an environment with normal network access.

### Merge of v1.0.1

After the successful CI result was confirmed, PR #2 was marked ready for review and merged using squash.

Merge result:

- PR: #2
- Merge method: squash
- Merged: yes
- Main commit: `1f0556623bc9d6ce318cad2ae533a286ac60cf89`
- Commit title: `fix: stabilize CI and add project log v1.0.1`
- Expected/verified head SHA at merge: `9c940b51d9ad3f37b50d111177a1b5fc86ec11ba`

At this point `main` contains the complete working implementation and the corrected CI configuration. v1.0.1 is the first version that has passed the entire install -> alpha sync -> syntax -> tests -> production build pipeline on GitHub Actions.

## 2026-08-14 - v1.0.2 release-state logging

Branch:

- `agent/v1.0.2`
- Based on `main` after the successful v1.0.1 squash merge.

Purpose:

- Preserve the successful CI and merge result in the permanent project log.
- Follow the project rule that every repository edit increments the version rather than mutating the prior version in place.

Changes:

- Bumped `package.json` from `1.0.1` to `1.0.2`.
- Updated `CHANGELOG.md` with the successful CI and merge state.
- Updated README version banner to `v1.0.2`.
- Updated this log with the completed CI and merge details.

Branch commits:

- `584618a05581fa4cf7e0772e1bd9a6f3eb661649` - `chore: bump version to v1.0.2`
- `457acfd241c4aab812963a8e6ecf5a23bfa10090` - `docs: record v1.0.2 release state`
- `0adc48f28f909f0d45fec5690671b633ecf3014d` - `docs: bump README to v1.0.2`
- `9ef4107248388c27c26f7b5a6dbadae9e8274b19` - final v1.0.2 branch head

PR:

- PR #3
- Title: `docs: record validated release state v1.0.2`
- Base: `main`
- Head: `agent/v1.0.2`
- 4 changed files
- 88 additions / 8 deletions

### Successful CI verification for PR #3

Workflow:

- Name: `CI`
- Run ID: `31770415114`
- Run number: `39`
- Job: `test-build`
- Job ID: `94674983049`
- Result: SUCCESS

Verified successful steps:

1. checkout - PASS
2. setup Node.js 22 - PASS
3. dependency install - PASS
4. pinned alpha synchronization - PASS
5. syntax checks - PASS
6. unit tests - PASS
7. Vite production build - PASS

### Merge of v1.0.2

PR #3 was marked ready for review and squash-merged after the successful CI result.

Merge result:

- PR: #3
- Merge method: squash
- Merged: yes
- Main commit: `d4a3ec8dca85156359c1f6e2455b7b02a1acacbf`
- Expected head SHA: `9ef4107248388c27c26f7b5a6dbadae9e8274b19`

v1.0.2 therefore became the stable `main` state before browser deployment work began.

## 2026-08-14 - v1.0.3 GitHub Pages deployment preparation

Branch:

- `agent/v1.0.3`
- Based on `main` at v1.0.2 merge commit `d4a3ec8dca85156359c1f6e2455b7b02a1acacbf`.

### Goal

Create a repeatable production web deployment path so the cleaner can be opened directly in a browser without manually running Vite locally, while keeping video processing local to the browser.

### GitHub Pages research and constraints

GitHub's current documentation confirms:

- GitHub Pages supports custom GitHub Actions workflows.
- The deployment job requires `pages: write` and `id-token: write` permissions.
- The standard artifact workflow uses `configure-pages`, `upload-pages-artifact`, and `deploy-pages`.
- GitHub Pages is available for private repositories only on account plans that support Pages for private repositories.
- A private repository does not automatically make its Pages site private. Pages sites are publicly available by default unless eligible organization/enterprise access control is explicitly configured.
- Privately published Pages access control requires an eligible GitHub Enterprise Cloud organization.

The GitHub connector's direct REST request for this repository's `/pages` configuration returned `403 Resource not accessible by integration`. Therefore repository Pages enablement cannot be changed through the connected integration in this environment. The workflow can still be committed; if Pages is not enabled, the remaining one-time UI step is documented in `DEPLOYMENT.md`.

### Action version verification

Before writing the deployment workflow, current GitHub releases were checked:

- `actions/checkout`: v7 series (`v7.0.1` latest observed)
- `actions/setup-node`: v7 (`v7.0.0` latest observed)
- `actions/configure-pages`: v6 (`v6.0.0` latest observed)
- `actions/upload-pages-artifact`: v5 (`v5.0.0` latest observed)
- `actions/deploy-pages`: v5 (`v5.0.0` latest observed)

The v1.0.3 workflows use these current major versions instead of the earlier v4 setup where appropriate.

### Deployment implementation

Added `.github/workflows/deploy-pages.yml` with:

- trigger on pushes to `main`,
- manual `workflow_dispatch`,
- Node.js 22,
- dependency installation,
- pinned alpha sync,
- syntax checks,
- unit tests,
- production Vite build,
- Pages artifact upload from `dist/`,
- `github-pages` environment deployment.

The workflow permissions are:

```yaml
contents: read
pages: write
id-token: write
```

The existing `vite.config.js` remains at `base: './'`. No source change is required because relative asset paths are suitable for the project-site path `/gemini-video-watermark-cleaner/` and avoid coupling the application to one hard-coded deployment root.

### CI modernization

Updated `.github/workflows/ci.yml`:

- `actions/checkout@v4` -> `actions/checkout@v7`
- `actions/setup-node@v4` -> `actions/setup-node@v7`

Node.js remains pinned to version 22 for the project test/build runtime.

### Documentation

Added/updated:

- `DEPLOYMENT.md`: production Pages runbook, one-time UI enablement, privacy warning, smoke test, regression evidence checklist, troubleshooting.
- `README.md`: v1.0.3 banner and deployment overview.
- `CHANGELOG.md`: v1.0.3 release notes.
- `PROJECT_LOG.md`: this complete deployment/release history.

### v1.0.3 branch commits

- `061fc94877b199f9e00a7cbb7be5dc095bb84e9b` - `feat: add GitHub Pages deployment workflow`
- `73d57b51c7d33537328ef3963c952e549c6fed61` - `chore: bump version to v1.0.3`
- `9219f9d4d07e7bd0a091a11865467f6daadcb953` - `ci: update core GitHub Actions to v7`
- `a944b148b89103516d0e09c6ad270c1ddfbe72a7` - `docs: add GitHub Pages deployment guide`
- `1e48caaca9779fdafb67d6abbdb51a4e1d269c1d` - `docs: add deployment runbook`
- `35d89f4b9a7c1e38ef49776d81eab2147eff83cb` - `docs: record v1.0.3 deployment changes`
- `2ee66e0e8e2fafb3aebac7fef4f01e536ef78753` - final v1.0.3 branch head

### PR #4 and CI verification

PR:

- PR #4
- Title: `feat: add GitHub Pages deployment v1.0.3`
- Base: `main`
- Head: `agent/v1.0.3`
- Head SHA: `2ee66e0e8e2fafb3aebac7fef4f01e536ef78753`
- 7 changed files
- 393 additions / 10 deletions

CI:

- Workflow: `CI`
- Run ID: `31772695918`
- Run number: `49`
- Job ID: `94681696549`
- Result: SUCCESS

Verified successful steps:

1. `actions/checkout@v7` - PASS
2. `actions/setup-node@v7` - PASS
3. dependency install - PASS
4. pinned alpha synchronization - PASS
5. syntax checks - PASS
6. unit tests - PASS, 5/5
7. Vite production build - PASS

### Merge of v1.0.3

After CI #49 was green, PR #4 was marked ready and squash-merged.

Merge result:

- PR: #4
- Merge method: squash
- Merged: yes
- Main commit: `0e0fd31fa048b84ce99e8f6a5fc062ed7316b26b`
- Expected head SHA: `2ee66e0e8e2fafb3aebac7fef4f01e536ef78753`

The merge immediately triggered both regular CI and the first `Deploy GitHub Pages` workflow on `main`.

### First production deployment attempt

Deployment workflow:

- Name: `Deploy GitHub Pages`
- Run ID: `31772735481`
- Run number: `1`
- Build job ID: `94681809508`
- Commit: `0e0fd31fa048b84ce99e8f6a5fc062ed7316b26b`

Successful build/validation steps:

1. checkout - PASS
2. Node.js 22 setup - PASS
3. `npm install --no-audit --no-fund` - PASS
4. `npm run setup:alpha` - PASS
5. `npm run check` - PASS
6. `npm test` - PASS, 5/5
7. `npm run build` - PASS

The production Vite build completed successfully. The log showed the generated `dist/` bundle, including the main JS/CSS and Web Worker asset.

Deployment then failed at:

- Step: `Configure GitHub Pages`
- Action: `actions/configure-pages@v6`

Observed error:

```text
Get Pages site failed. Please verify that the repository has Pages enabled and configured to build using GitHub Actions.
```

The next artifact-upload step was skipped, so no Pages deployment occurred.

### Root cause and enablement research

The build itself is not the problem. GitHub Pages is not yet enabled/configured for the repository.

The current `actions/configure-pages` action definition was inspected. Its `enablement` option can try to enable Pages, but automatic enablement explicitly requires a token other than the default `GITHUB_TOKEN`.

Required permissions depend on token type:

- Personal Access Token: repository/Pages write capability as documented by the action.
- GitHub App token: `administration:write` and `pages:write`.

The project will not introduce an additional privileged PAT solely to automate a one-time repository setting. The safer next action is the GitHub UI setting already documented in `DEPLOYMENT.md`.

## 2026-08-14 - v1.0.4 deployment-state logging

Branch:

- `agent/v1.0.4`
- Based on `main` at v1.0.3 merge commit `0e0fd31fa048b84ce99e8f6a5fc062ed7316b26b`.

Purpose:

- Record the completed v1.0.3 CI/merge/deployment attempt without losing the exact run IDs and root cause.
- Keep the repository versioning rule: every repository edit increments the version.
- Avoid merging another release to `main` while Pages remains disabled, because that would only trigger another known-failing deployment run.

Changes:

- Bumped package version to `1.0.4`.
- Updated README with the current deployment state and exact remaining UI step.
- Updated `CHANGELOG.md` with the v1.0.3 CI, merge, and deployment result.
- Updated `DEPLOYMENT.md` with run IDs, successful build evidence, exact Pages error, and the reason automatic enablement is not used.
- Updated this project log with the complete v1.0.3 result.

### Current blocker

One-time GitHub repository action required:

**Settings -> Pages -> Build and deployment -> Source: GitHub Actions**

Because the repository is private, GitHub must also show Pages as available for the account plan. If the UI instead requires a plan upgrade, do not make the repository public automatically; decide explicitly whether to upgrade, expose the source, or use another host.

### Next action

1. Keep v1.0.4 as an unmerged draft branch/PR.
2. Enable GitHub Pages in repository Settings if the account plan permits it.
3. Re-run the existing `Deploy GitHub Pages` workflow from `main` and confirm configure/upload/deploy all pass.
4. Once the site is live, merge the v1.0.4 documentation state only after CI is green.
5. Run a real Gemini/Veo video regression test in the deployed browser app and record the result before changing cleanup algorithms.
