# Gemini Video Watermark Cleaner

**v1.0.17** - local-first browser tool for cleaning the **visible** Gemini/Veo watermark overlay from videos you own or are authorized to edit.

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

## v1.0.17 highlights

- Keeps the v1.0.16 detail-preserving core and normal-direction edge bridge that substantially reduced the visible Gemini outline in real-video testing.
- Adds **subpixel alpha registration** after coarse alpha calibration so the alpha footprint can move by `-0.4 / 0 / +0.4 px` in X and Y without moving the video or integer detector box.
- Tightens shape-scale search to `0.985 / 1.000 / 1.015`, reflecting that the remaining artifact is now a thin anti-aliased edge rather than a large footprint mismatch.
- Uses a two-stage bounded search: 54 coarse profile/shape/edge candidates, then only 9 subpixel registrations around the coarse winner.
- Splits calibration diagnostics into **Edge**, **Low body**, **High body**, and outside/near-zero residual buckets.
- Weights edge residual most strongly while preserving penalties for body damage, so calibration can target a thin outline without flattening the restored core texture.
- Shows selected Offset X/Y and residual buckets directly in the Tune panel.
- Detector/catalog integer geometry remains unchanged; v1.0.17 improves alpha registration inside the already-correct 72x72 watermark ROI.

## Main features

- 100% local video processing in the browser; no media upload.
- MP4/MOV/M4V/WebM file selection with MIME/extension fallback.
- Automatic quick detection after file selection with residual-gated full-scan fallback.
- Full-frame preview with detected Gemini bounding box.
- `ZOOMED ORIGINAL` and `ZOOMED CLEANED` ROI previews generated in a Web Worker.
- Automatic body + edge alpha calibration with fractional X/Y registration.
- Known 1080p, 720p and portrait Veo geometry candidates with local coordinate refinement.
- Spatial + gradient correlation detector.
- Fail-closed confidence threshold plus manual override/force-cleanup fallback.
- Inverse-alpha restoration, bounded adaptive per-frame body gain and scene-cut reset.
- Hybrid detail-preserving core / aggressive edge-ring repair.
- Normal-direction edge bridge for thin residual outlines.
- Optional padded temporal donor and multi-frame atlas support.
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

Choose or drop a Gemini/Veo video. Analysis starts automatically. A high-confidence quick result is shown only when both detector confidence and calibration quality are acceptable; otherwise the app expands to the configured full scan. Use **Re-analyze full video** only when you explicitly want another detector/calibration pass.

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
  -> integer local coordinate refinement
  -> initial body alpha-gain estimate
  -> independent body-gain search
  -> bounded profile + shape scale + edge boost + edge gain search
  -> subpixel alpha registration (-0.4 / 0 / +0.4 px X/Y)
  -> Edge / Low-body / High-body residual scoring
  -> selected calibrated alpha map + calibrated body gain
  -> show box + calibrated ROI preview
  -> automatically run full scan when quick detection/calibration is not strong enough
```

## Cleanup/export pipeline

```text
Detected region + subpixel-calibrated alpha map
  -> per-frame confidence gate
  -> adaptive body gain clamped around calibrated value
  -> inverse-alpha restoration
  -> detail-preserving hybrid core/ring repair
  -> padded texture repair
  -> optional temporal donor / multi-frame atlas
  -> normal-direction edge bridge
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
- **Body gain**: automatically calibrated main watermark opacity.
- **Shape scale**: selected alpha-footprint scale around the watermark center; v1.0.17 uses a narrow search around 1.0.
- **Offset X / Y**: fractional alpha-map registration in pixels. These values do not move the detector bounding box or source video.
- **Edge gain / Edge boost**: alpha adjustments focused on low-alpha/gradient regions.
- **Total residual**: combined calibration objective; lower is better within the candidate set.
- **Edge residual**: thin-outline/anti-alias mismatch indicator. When this remains high while body residuals are low, registration/edge fitting should improve instead of stronger body cleanup.
- **Low-body / High-body residual**: diagnostics for interior watermark reconstruction; high values warn against aggressive edge changes that damage core texture.
- **Edge polish**: default 0.35. Avoid raising aggressively unless visual testing justifies it.
- **Adaptive body gain**: recommended; constrained around the calibrated value to avoid drift.
- **Detail core + edge bridge + atlas**: recommended for real video; core protection remains active even when temporal donors are available.
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
- Residual scoring and background-continuity estimation are heuristic; very complex moving texture can still be difficult.
- The subpixel grid is intentionally bounded for browser performance rather than an exhaustive optimizer.
- Chroma-subsampling halos from compressed video may remain even after luma/alpha registration is correct; a future quality tier may need chroma-aware edge correction.
- ML/FDnCNN remains an optional future quality tier rather than a default dependency.

## Responsible use

Use this software only on content you own or have permission to modify. Removing a visible overlay may affect disclosure requirements on some platforms or in some jurisdictions; you are responsible for how exported media is labeled and distributed.

## License

MIT. See [`LICENSE`](./LICENSE) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).
