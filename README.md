# Gemini Video Watermark Cleaner

**v1.0.10** - local-first browser tool for cleaning the **visible** Gemini/Veo watermark overlay from videos you own or are authorized to edit.

> This project does **not** attempt to remove invisible provenance/watermarking systems such as SynthID.

## Why this implementation

This repository was designed after studying two MIT-licensed projects:

- `ishara-madu/gemini-watermark-remover` - lightweight browser UX and deployment ideas.
- `GargantuaX/gemini-watermark-remover` - deeper video detection, alpha-profile, residual-cleanup and export research.

The implementation is independently structured, video-focused and local-first. See [`RESEARCH.md`](./RESEARCH.md), [`ATTRIBUTION.md`](./ATTRIBUTION.md), [`PROJECT_LOG.md`](./PROJECT_LOG.md), [`logs/`](./logs/) and [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Production site

```text
https://dhvu1990.github.io/gemini-video-watermark-cleaner/
```

## v1.0.10 highlights

- Adds **automatic alpha-shape calibration** after the watermark position is detected.
- Tests a bounded 54-combination search across embedded alpha profile, footprint scale, edge boost and edge gain on up to three sampled watermark ROIs.
- Chooses the configuration with the lowest residual diamond-edge score while penalizing changes outside the watermark footprint.
- Separates **Body gain** from **Edge gain** so the outline can be corrected more aggressively without globally over-darkening the already-cleaned center.
- Reuses the calibrated alpha map inside the current Web Worker for full-video export, so calibration is not repeated at export time.
- `ZOOMED CLEANED` uses the same calibrated alpha map that export will use.
- Tune displays selected Profile, Shape scale, Edge gain, Edge boost and Residual score.
- Keeps detector position/catalog geometry unchanged from v1.0.9.

## Main features

- 100% local video processing in the browser; no media upload.
- MP4/MOV/M4V/WebM file selection with MIME/extension fallback.
- Automatic quick detection after file selection with full-scan fallback.
- Full-frame preview with detected Gemini bounding box.
- `ZOOMED ORIGINAL` and `ZOOMED CLEANED` ROI previews generated in a Web Worker.
- Automatic alpha-shape calibration for the detected watermark footprint.
- Known 1080p, 720p and portrait Veo geometry candidates with local coordinate refinement.
- Spatial + gradient correlation detector.
- Fail-closed confidence threshold plus manual override/force-cleanup fallback.
- Inverse-alpha restoration, adaptive per-frame body gain, scene-cut reset and temporal stabilization.
- Edge-weighted alpha gain plus residual edge/footprint cleanup for the visible diamond border.
- MediaBunny/WebCodecs AVC MP4 export with compatible encoded-audio passthrough.
- Direct cleaned-video result preview in the browser before download.
- Progress reporting, cancellation, tests, CI and GitHub Pages deployment.

## Quick start

Requirements: Node.js 20+ and a recent Chromium-based browser with WebCodecs video encoding support.

```bash
npm install
npm run setup:alpha
npm run dev
```

Choose or drop a Gemini/Veo video. Analysis starts automatically. A high-confidence quick result is shown after position detection and alpha calibration; otherwise the app expands to the configured full scan. Use **Re-analyze full video** only when you explicitly want another detector/calibration pass.

After **Clean video** completes, review the generated MP4 directly in **4. Result preview**. Download it only after the in-browser playback looks correct.

### Why `npm run setup:alpha`?

The setup command downloads three alpha profiles from a pinned MIT-licensed upstream commit and generates `src/vendor/alphaPayload.js`. The runtime itself remains local after the assets are bundled. If the sync command is not run, the application falls back to a procedural alpha template, which is less accurate for real Gemini/Veo material.

## Detection and calibration pipeline

```text
Local video
  -> file validation
  -> local browser preview
  -> Worker quick scan: 3 frames from first 18%
  -> catalog candidates + spatial/gradient scoring
  -> local coordinate refinement
  -> body alpha-gain estimate
  -> bounded alpha-shape calibration on up to 3 ROIs
  -> selected profile + shape scale + edge boost + edge gain
  -> show box + calibrated ROI preview
  -> automatically run full scan only if quick detection is not strong enough
```

## Cleanup/export pipeline

```text
Detected region + calibrated alpha map
  -> per-frame confidence gate
  -> adaptive body gain
  -> inverse-alpha restoration
  -> calibrated edge gain/footprint
  -> masked edge polish
  -> residual footprint cleanup + structure guard
  -> temporal correction stabilization
  -> WebCodecs AVC encode
  -> encoded audio passthrough
  -> MediaBunny MP4 mux
  -> local Blob URL
  -> in-browser Result preview + optional download
```

## Supported layout priors

- 1920x1080: 72 px standard and inset layouts.
- 1280x720: 48 px standard/inset plus compact layout.
- 1080x1920 portrait: 72 px standard/inset.
- 720x1280 portrait: standard/relocated/compact variants.
- Other sizes: projected candidates from reference geometry.

## Tuning guide

- **Full scan frames**: 12 is the normal fallback. Increase for unusually long or highly edited videos.
- **Min confidence**: default 0.12; quick acceptance is deliberately stricter.
- **Body gain**: detected main watermark opacity. Normally keep the detected value; adaptive correction may adjust it per frame.
- **Edge gain**: selected automatically by calibration and displayed read-only. It targets low-alpha/gradient regions rather than multiplying the entire watermark.
- **Shape scale**: selected alpha-footprint scale around the watermark center.
- **Edge boost**: selected low-alpha edge enhancement used to better cover the visible outline.
- **Residual score**: calibration objective; lower is better within the tested candidate set, but visual review remains the final quality check.
- **Edge polish**: default 0.35. Residual footprint cleanup is bounded, so avoid raising this aggressively unless testing shows it is needed.
- **Adaptive body gain**: recommended.
- **Temporal stabilization**: recommended for static/slow backgrounds.
- **Manual override / Force cleanup**: only when automatic detection is uncertain.

## Production build

```bash
npm install
npm run setup:alpha
npm run check
npm test
npm run build
```

The generated `dist/` directory is static and is deployed by `.github/workflows/deploy-pages.yml` on pushes to `main`.

## Current limitations

- Video is re-encoded to AVC/H.264 MP4; export is not lossless.
- Audio is copied only when its encoded codec can be placed directly into MP4.
- The calibration grid is intentionally bounded for browser performance; a future watermark variant may still require new profiles or wider search ranges.
- Highly textured backgrounds may still show some residual artifacts even after calibration.
- ML/FDnCNN remains an optional future quality tier rather than a default dependency.

## Responsible use

Use this software only on content you own or have permission to modify. Removing a visible overlay may affect disclosure requirements on some platforms or in some jurisdictions; you are responsible for how exported media is labeled and distributed.

## License

MIT. See [`LICENSE`](./LICENSE) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).
