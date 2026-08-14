# Gemini Video Watermark Cleaner

**v1.0.8** - local-first browser tool for cleaning the **visible** Gemini/Veo watermark overlay from videos you own or are authorized to edit.

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

## v1.0.8 highlights

- Automatic detection immediately after selecting a video.
- Faster progressive quick scan: **3 frames over the first 18%** of the video, with a stricter acceptance threshold and automatic full-scan fallback when needed.
- Visible spinner on the analysis button while quick/full analysis is running.
- More compact portrait preview so the full-frame video is visually balanced with the two ROI zoom cards.
- Detector geometry remains unchanged from the validated v1.0.7 path.
- Cleanup now adds a lightweight browser-side **low-alpha edge enhancement** for the cleanup mask only.
- After inverse-alpha restoration, an **edge-aware residual footprint cleanup** targets the remaining diamond outline while using a luma structure guard to reduce damage to real image detail.
- The same cleanup path is used by `ZOOMED CLEANED` and full-video export, so the preview is a better representation of the expected result.
- No ML/FDnCNN dependency is required for this release.

## Main features

- 100% local video processing in the browser; no media upload.
- MP4/MOV/M4V/WebM file selection with MIME/extension fallback.
- Full-frame preview with detected Gemini bounding box.
- `ZOOMED ORIGINAL` and `ZOOMED CLEANED` ROI previews generated in a Web Worker.
- Known 1080p, 720p and portrait Veo geometry candidates with local coordinate refinement.
- Spatial + gradient correlation detector.
- Fail-closed confidence threshold plus manual override/force-cleanup fallback.
- Inverse-alpha restoration, adaptive per-frame alpha, scene-cut reset and temporal stabilization.
- Residual edge/footprint cleanup for the visible diamond border.
- MediaBunny/WebCodecs AVC MP4 export with compatible encoded-audio passthrough.
- Progress reporting, cancellation, tests, CI and GitHub Pages deployment.

## Quick start

Requirements: Node.js 20+ and a recent Chromium-based browser with WebCodecs video encoding support.

```bash
npm install
npm run setup:alpha
npm run dev
```

Choose or drop a Gemini/Veo video. Analysis starts automatically. A high-confidence quick result is shown immediately; otherwise the app expands to the configured full scan. Use **Re-analyze full video** only when you explicitly want another full detector pass.

### Why `npm run setup:alpha`?

The setup command downloads three alpha profiles from a pinned MIT-licensed upstream commit and generates `src/vendor/alphaPayload.js`. The runtime itself remains local after the assets are bundled. If the sync command is not run, the application falls back to a procedural alpha template, which is less accurate for real Gemini/Veo material.

## Detection pipeline

```text
Local video
  -> file validation
  -> local browser preview
  -> Worker quick scan: 3 frames from first 18%
  -> catalog candidates + spatial/gradient scoring
  -> local coordinate refinement
  -> strict quick-result gate
  -> show box + ROI previews OR automatically run full 12-frame scan
```

## Cleanup/export pipeline

```text
Detected region
  -> per-frame confidence gate
  -> inverse-alpha restoration
  -> cleanup-only low-alpha edge enhancement
  -> masked edge polish
  -> residual footprint cleanup + structure guard
  -> temporal correction stabilization
  -> WebCodecs AVC encode
  -> encoded audio passthrough
  -> MediaBunny MP4 mux
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
- **Alpha gain**: normally keep the detected value.
- **Edge polish**: default 0.35. v1.0.8 also applies bounded residual footprint cleanup, so avoid raising this aggressively unless testing shows it is needed.
- **Adaptive alpha**: recommended.
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
- Future Gemini/Veo watermark geometry or alpha changes may require catalog/profile updates.
- Residual cleanup is intentionally lightweight and structure-guarded; highly textured backgrounds may still show some artifacts.
- ML/FDnCNN remains an optional future quality tier rather than a default dependency.

## Responsible use

Use this software only on content you own or have permission to modify. Removing a visible overlay may affect disclosure requirements on some platforms or in some jurisdictions; you are responsible for how exported media is labeled and distributed.

## License

MIT. See [`LICENSE`](./LICENSE) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).
