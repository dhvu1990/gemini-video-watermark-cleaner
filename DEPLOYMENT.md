# Deployment Runbook

## Target

Primary deployment target for v1.0.3:

```text
GitHub Pages
https://dhvu1990.github.io/gemini-video-watermark-cleaner/
```

The project is a static Vite application. Runtime video processing stays in the user's browser; the deployment only serves HTML, CSS, JavaScript, workers, and bundled alpha-profile data.

## Repository state

- Repository: `dhvu1990/gemini-video-watermark-cleaner`
- Default branch: `main`
- Repository visibility at v1.0.3 preparation: private
- Deployment workflow: `.github/workflows/deploy-pages.yml`
- Vite base: `./`

The relative Vite base is intentional. It allows the built site to work from a project subpath such as `/gemini-video-watermark-cleaner/` without hard-coding the repository name into application source.

## GitHub Pages prerequisites

GitHub Pages must be available for the account/repository plan and enabled for this repository.

For a private repository owned by a personal account, GitHub Pages requires a GitHub plan that supports Pages for private repositories. A private repository does not automatically mean the published Pages site is private. GitHub Pages sites are publicly available by default unless Pages access control is available and explicitly configured; privately published Pages sites require an eligible organization/enterprise setup.

Do not place secrets, API keys, private customer data, or private source-only information into files that are included in `dist/`.

## One-time GitHub UI configuration

If the deploy workflow reports that GitHub Pages is not configured:

1. Open the repository on GitHub.
2. Open **Settings**.
3. In **Code and automation**, open **Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. Save/apply if GitHub presents a confirmation.
6. Re-run the failed `Deploy GitHub Pages` workflow, or push a new validated release to `main`.

## Deployment workflow

The deployment workflow runs on every push to `main` and can also be started manually.

Build stage:

```text
checkout
-> Node.js 22
-> npm install
-> npm run setup:alpha
-> npm run check
-> npm test
-> npm run build
-> configure-pages
-> upload dist artifact
```

Deployment stage:

```text
uploaded Pages artifact
-> github-pages environment
-> actions/deploy-pages
-> published site URL
```

Required workflow permissions:

```yaml
contents: read
pages: write
id-token: write
```

## Expected production URL

For a normal public project site:

```text
https://dhvu1990.github.io/gemini-video-watermark-cleaner/
```

If Pages access control/private publication is used through an eligible GitHub Enterprise Cloud organization, GitHub may provide a different private Pages hostname. In that case use the URL shown in **Settings -> Pages** or the deploy job output.

## Post-deployment smoke test

After a successful deployment:

1. Open the published URL in current Chrome or Edge.
2. Confirm the page loads without 404 errors.
3. Open DevTools -> Console and confirm there are no failed JS/worker imports.
4. Load one real Gemini/Veo video.
5. Run **Analyze watermark**.
6. Confirm the detected region is visually aligned with the visible watermark.
7. Run **Clean video** on a short sample.
8. Download/play the resulting MP4.
9. Confirm video plays, audio remains present when the source audio codec is compatible, and the cleaned region does not flicker across scene changes.

## Regression evidence to preserve

For each real-video test, record in `PROJECT_LOG.md`:

- release version,
- input resolution,
- duration,
- detected geometry,
- detector confidence,
- alpha gain,
- result quality,
- audio result,
- browser/version,
- any artifact/failure,
- follow-up change if needed.

Do not commit customer/private videos into the repository. Use local test media unless a sanitized redistributable sample is intentionally added later.

## Troubleshooting

### `Get Pages site failed` or Pages not configured

Enable **Settings -> Pages -> Source: GitHub Actions**, then re-run deployment.

### Site opens but JS/CSS returns 404

Confirm `vite.config.js` still uses:

```js
base: './'
```

Then rebuild and redeploy.

### Build fails during alpha sync

Check access to the pinned upstream raw GitHub source and verify `scripts/sync-alpha-assets.mjs` still matches the pinned source layout.

### WebCodecs is unavailable

Use a recent Chromium-based browser. The page can load without WebCodecs, but video encoding requires browser support for the configured codec path.

### Pages site must not be public

Do not enable a normal public Pages deployment for sensitive use. GitHub Pages private access control requires an eligible GitHub Enterprise Cloud organization. Otherwise use an authenticated internal web server or another private hosting solution instead.
