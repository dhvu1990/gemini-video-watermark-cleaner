# Changelog

## 1.0.4 - 2026-08-14

- Recorded successful v1.0.3 CI validation on PR #4 using `actions/checkout@v7` and `actions/setup-node@v7`.
- Recorded successful squash merge of v1.0.3 into `main` as commit `0e0fd31fa048b84ce99e8f6a5fc062ed7316b26b`.
- Recorded the first production Pages deployment attempt: install, alpha sync, syntax checks, 5/5 tests, and Vite build all passed.
- Recorded the deployment blocker: `actions/configure-pages@v6` returned `Get Pages site failed` because GitHub Pages is not yet enabled/configured for the repository.
- Documented that automatic Pages enablement requires a token other than the default `GITHUB_TOKEN`; the repository therefore keeps a one-time manual Settings -> Pages -> GitHub Actions enablement step.
- Bumped package and README version to `1.0.4` while leaving this release unmerged until Pages is enabled.

## 1.0.3 - 2026-08-14

- Added a GitHub Pages production deployment workflow that builds, validates, uploads, and deploys the Vite `dist/` artifact from `main`.
- Added `DEPLOYMENT.md` with the exact Pages enablement checklist, privacy notes, smoke-test procedure, regression evidence checklist, and troubleshooting guidance.
- Updated CI from `actions/checkout@v4` / `actions/setup-node@v4` to current major v7 releases.
- Kept Vite `base: './'` because relative assets are appropriate for the GitHub Pages project subpath.
- Documented that a private repository does not automatically make a Pages site private and that private Pages access control requires an eligible organization/enterprise setup.
- Bumped package and README version to `1.0.3`.

## 1.0.2 - 2026-08-14

- Recorded successful GitHub Actions validation for PR #2: dependency install, pinned alpha-profile sync, syntax checks, unit tests, and Vite production build all passed.
- Recorded successful squash merge of PR #2 into `main` as commit `1f0556623bc9d6ce318cad2ae533a286ac60cf89`.
- Continued the permanent project execution log so merge and release state are not lost between iterations.

## 1.0.1 - 2026-08-14

- Fixed GitHub Actions CI startup failure caused by `actions/setup-node@v4` using `cache: npm` without a committed npm lockfile.
- CI now uses Node.js 22 without npm cache, then runs dependency install, alpha-profile synchronization, syntax checks, unit tests, and production build.
- Added a dedicated project execution log to preserve repository research, implementation, validation, CI failures, fixes, branch/commit/PR history, and next-step status.

## 1.0.0 - 2026-08-14

- Initial independent release.
- Added browser-local MediaBunny/WebCodecs video pipeline.
- Added multi-frame watermark detection with known Veo layout catalog and local refinement.
- Added inverse-alpha restoration, adaptive alpha cap, confidence gate, masked edge polish, temporal correction stabilization, and scene-cut state reset.
- Added audio passthrough for MP4-compatible source audio codecs.
- Added manual region override, progress/cancel flow, unit tests, CI, research notes, and third-party attribution.
