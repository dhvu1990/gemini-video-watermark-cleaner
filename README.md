# Gemini Video Watermark Cleaner

**v1.0.33** - local-first browser tool for cleaning the **visible** Gemini/Veo watermark overlay from videos you own or are authorized to edit.

> This project does **not** attempt to remove invisible provenance/watermarking systems such as SynthID.

## Runtime

The primary runtime is a **private GitHub Codespace** serving Vite on private forwarded port `5173`.

```text
Private GitHub repository
-> GitHub Codespace
-> Vite :5173
-> private *.app.github.dev forwarded URL
-> authenticated browser
```

The exact `*.app.github.dev` hostname is dynamic and may change if the Codespace is recreated. The stable deployment model is **Codespaces + private port 5173**, not GitHub Pages and not a hard-coded hostname.

See [`CODESPACES.md`](./CODESPACES.md), [`DEPLOYMENT.md`](./DEPLOYMENT.md), and [`WINDOWS_LAUNCHER.md`](./WINDOWS_LAUNCHER.md).

## Why this implementation

This repository was designed after studying two MIT-licensed projects:

- `ishara-madu/gemini-watermark-remover` - lightweight browser UX and deployment ideas.
- `GargantuaX/gemini-watermark-remover` - deeper video detection, alpha-profile, residual-cleanup and export research.

The implementation is independently structured, video-focused and local-first. See [`RESEARCH.md`](./RESEARCH.md), [`ATTRIBUTION.md`](./ATTRIBUTION.md), [`PROJECT_LOG.md`](./PROJECT_LOG.md), and [`logs/`](./logs/).

## v1.0.33 state

- Keeps the v1.0.31 structured directional consensus reconstruction for difficult structured backgrounds.
- Keeps the v1.0.32 application code state while correcting the deployment/runtime model.
- Makes private GitHub Codespaces port `5173` the documented primary runtime.
- Removes the obsolete automatic GitHub Pages deployment workflow so pushes to `main` do not create irrelevant failed Pages runs.
- Preserves the rule that the current Codespaces `browseUrl` is discovered dynamically rather than hard-coded.

## Main features

- 100% local video processing in the browser; no media upload.
- MP4/MOV/M4V/WebM file selection with MIME/extension fallback.
- Automatic quick detection with residual-gated full-scan fallback.
- Full-frame preview with detected watermark region.
- `ZOOMED ORIGINAL` and `ZOOMED CLEANED` ROI previews.
- Automatic body + edge alpha calibration with subpixel registration.
- Known 1080p, 720p and portrait Veo geometry candidates with local refinement.
- Spatial + gradient correlation detector.
- Fail-closed confidence threshold plus manual override/force cleanup.
- Inverse-alpha restoration and adaptive body gain.
- Smooth-background reconstruction and safe empty-zone hard suppression.
- Structured directional consensus reconstruction.
- Structured residual ring suppression with bounded micro-salvage.
- Detail-preserving hybrid core/ring repair.
- Normal-direction edge bridge and dual-ring finishing.
- Optional temporal donor / multi-frame atlas support.
- MediaBunny/WebCodecs AVC MP4 export with compatible audio passthrough.
- Direct cleaned-video result preview before download.
- Progress reporting, cancellation, tests and CI.

## Quick start

Requirements: Node.js 20+ and a recent Chromium-based browser with WebCodecs support.

```bash
npm install --no-audit --no-fund
npm run setup:alpha
npm run dev -- --host 0.0.0.0 --port 5173
```

Inside Codespaces, `.devcontainer/start-vite.sh` starts Vite automatically on port `5173`.

## Validation

```bash
npm install --no-audit --no-fund
npm run setup:alpha
npm run check
npm test
npm run build
```

A successful static build is still required for regression validation even though the day-to-day private runtime is the Codespaces Vite server.

## Cleanup pipeline

```text
Detected region + calibrated alpha map
-> per-frame confidence gate
-> adaptive body gain
-> inverse-alpha restoration
-> detail-preserving hybrid core/ring repair
-> padded texture repair
-> optional temporal donor / multi-frame atlas
-> normal-direction edge bridge
-> dual-ring/adaptive background finish
-> structured directional consensus repair when appropriate
-> structured ring suppression / micro-salvage
-> WebCodecs AVC encode
-> encoded audio passthrough when compatible
-> local Blob URL
-> in-browser result preview + optional download
```

## Supported layout priors

- 1920x1080: 72 px standard and inset layouts.
- 1280x720: 48 px standard/inset plus compact layout.
- 1080x1920 portrait: 72 px standard/inset.
- 720x1280 portrait: standard/relocated/compact variants.
- Other sizes: projected candidates from reference geometry.

## Current limitations

- Video is re-encoded to AVC/H.264 MP4; export is not lossless.
- Audio is copied only when its encoded codec is compatible with MP4 passthrough.
- Very complex moving texture can still leave visible residuals or reconstruction artifacts.
- Chroma-subsampling halos can remain even when luma/alpha registration is good.
- Real-video visual regression remains essential before increasing cleanup aggressiveness.

## Responsible use

Use this software only on content you own or have permission to modify. Removing a visible overlay may affect disclosure requirements on some platforms or in some jurisdictions; you are responsible for how exported media is labeled and distributed.

## License

MIT. See [`LICENSE`](./LICENSE) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).
