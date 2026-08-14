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

Branch commits so far:

- `584618a05581fa4cf7e0772e1bd9a6f3eb661649` - `chore: bump version to v1.0.2`
- `457acfd241c4aab812963a8e6ecf5a23bfa10090` - `docs: record v1.0.2 release state`
- `0adc48f28f909f0d45fec5690671b633ecf3014d` - `docs: bump README to v1.0.2`

### Current state and next action

- `main`: working v1.0.1 implementation, CI green, full build validated.
- `agent/v1.0.2`: documentation/version follow-up that records the successful release state.
- Next action: validate v1.0.2 CI, merge it into `main`, then move to browser deployment/real-video regression testing and only promote additional cleanup backends or watermark variants after representative tests exist.
