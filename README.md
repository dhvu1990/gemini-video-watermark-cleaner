# Gemini Video Watermark Cleaner

**v1.0.3** - local-first browser tool for cleaning the **visible** Gemini/Veo watermark overlay from videos you own or are authorized to edit.

> This project does **not** attempt to remove invisible provenance/watermarking systems such as SynthID.

## Why this implementation

This repository was designed after studying two MIT-licensed projects:

- `ishara-madu/gemini-watermark-remover` - excellent lightweight browser UX and deployment model.
- `GargantuaX/gemini-watermark-remover` - deeper detector/export architecture, multi-frame logic, alpha-profile research, confidence gating, tests and video quality work.

The goal here is not to mirror either codebase. It is a smaller independent video-focused implementation that keeps the strongest stable ideas and avoids making experimental ML denoise a required dependency.

See [`RESEARCH.md`](./RESEARCH.md) for the technical comparison, [`ATTRIBUTION.md`](./ATTRIBUTION.md) for third-party notices, [`PROJECT_LOG.md`](./PROJECT_LOG.md) for the complete execution history, and [`DEPLOYMENT.md`](./DEPLOYMENT.md) for web deployment.

## Features

- 100% local video processing in the browser.
- 12-frame multi-frame analysis by default.
- Known 1080p, 720p and portrait Veo watermark candidates.
- Local coordinate refinement around the best known candidate.
- Spatial + gradient correlation detector.
- Fail-closed detection threshold with explicit **Force cleanup** override.
- Manual X/Y/size override for unseen or relocated layouts.
- Inverse-alpha restoration rather than whole-box blur.
- Adaptive alpha with per-frame correction step cap.
- Scene-cut reset so alpha/temporal history does not leak into a new shot.
- Masked edge polish for residual diamond edges.
- Temporal correction stabilization on low-motion pixels.
- MP4 export through MediaBunny + WebCodecs.
- Encoded audio passthrough when the input codec is compatible with MP4 output.
- BT.709 color metadata on encoded video.
- Web Worker processing, progress reporting and cancellation.
- Unit tests and GitHub Actions CI.
- GitHub Pages production deployment workflow.

## Quick start

Requirements: Node.js 20+ and a recent Chromium-based browser with WebCodecs video encoding support.

```bash
npm install
npm run setup:alpha
npm run dev
```

Open the local Vite URL, drop in a Gemini/Veo video, run **Analyze watermark**, review the detected position/confidence, then click **Clean video**.

### Why `npm run setup:alpha`?

The repository keeps third-party alpha-profile data traceable instead of hand-copying a huge generated payload into the initial source. The setup command downloads three alpha profiles from a **pinned** MIT-licensed upstream commit and generates `src/vendor/alphaPayload.js`.

If the sync command is not run, the app still starts with a procedural fallback alpha template, but the pinned alpha data is recommended for real Gemini/Veo videos.

## Production build

```bash
npm install
npm run setup:alpha
npm run check
npm test
npm run build
```

The resulting `dist/` folder is static and can be hosted on GitHub Pages, Cloudflare Pages, Netlify, an internal web server, or any static hosting service.

## GitHub Pages deployment

v1.0.3 adds `.github/workflows/deploy-pages.yml`.

On every push to `main`, the workflow:

1. checks out the repository,
2. installs Node.js 22,
3. installs dependencies,
4. synchronizes the pinned alpha profiles,
5. runs syntax checks,
6. runs unit tests,
7. builds the Vite production bundle,
8. uploads `dist/` as the Pages artifact,
9. deploys it to the `github-pages` environment.

The current Vite setting uses `base: './'`, so generated JS/CSS/worker asset URLs remain relative and work under the repository project path without hard-coding the repository name.

If GitHub Pages is enabled for the repository, the expected project URL is:

```text
https://dhvu1990.github.io/gemini-video-watermark-cleaner/
```

This repository is currently private. GitHub Pages for a private personal repository requires a plan that supports Pages for private repositories. If Pages has not yet been enabled, open **Repository Settings -> Pages -> Build and deployment** and select **GitHub Actions** as the source. See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the exact checklist and troubleshooting notes.

## Default processing pipeline

```text
Local MP4
  -> MediaBunny demux
  -> sample 12 frames
  -> catalog candidates
  -> spatial + gradient scoring
  -> local position refinement
  -> alpha-gain estimate
  -> full-frame decode
  -> confidence gate per frame
  -> inverse-alpha restoration
  -> masked edge polish
  -> temporal correction stabilization
  -> WebCodecs AVC encode
  -> encoded audio passthrough
  -> MediaBunny MP4 mux
```

## Supported layout priors

The catalog currently includes priors for:

- 1920x1080: 72 px standard and inset layouts.
- 1280x720: 48 px standard/inset plus a 44 px compact layout.
- 1080x1920 portrait: 72 px standard/inset.
- 720x1280 portrait: 48 px standard/relocated plus compact variants.
- Other sizes: projected candidates from the 1920x1080 reference geometry.

The detector locally searches around the best prior instead of assuming the anchor is exact.

## Tuning guide

- **Sample frames**: 12 is the normal balance. Raise toward 18-24 for longer videos with fades or scene changes.
- **Min confidence**: default 0.12. Raising it is safer but may reject weak watermarks.
- **Alpha gain**: normally leave at the detected value after analysis.
- **Edge polish**: default 0.35. Increase carefully if a thin diamond outline remains.
- **Adaptive alpha**: recommended; changes are capped frame-to-frame to reduce flicker.
- **Temporal stabilization**: recommended for static/slow backgrounds; it is motion-gated.
- **Force cleanup**: use only after visually confirming the target region.
- **Manual override**: use when Gemini/Veo changes watermark placement or the detector is uncertain.

## Current limitations

- The browser path currently exports AVC/H.264 MP4 and re-encodes video; it is not lossless.
- Audio is copied only when the source audio codec can be placed directly into MP4; unsupported audio is omitted rather than transcoded in-browser.
- Detection is optimized for the visible Gemini/Veo diamond-style overlay and known layout families. Future Google changes may require catalog/alpha updates.
- The fallback procedural alpha template is approximate; run `npm run setup:alpha` for the pinned reference profiles.
- ML/FDnCNN denoise is intentionally not a v1 default. A masked, benchmarked optional backend can be added later without changing the main restoration architecture.
- GitHub Pages availability depends on repository visibility/account plan and repository Pages settings.

## Development

```bash
npm run check
npm test
npm run build
```

CI repeats the same checks after synchronizing the pinned alpha profiles.

## Responsible use

Use this software only on content you own or have permission to modify. Removing a visible overlay may affect disclosure requirements on some platforms or in some jurisdictions; you are responsible for how exported media is labeled and distributed.

## License

MIT. See [`LICENSE`](./LICENSE) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).
