# Research notes - Gemini/Veo visible video watermark removal

Version: 1.0.0  
Research date: 2026-08-14

## Reference A - ishara-madu/gemini-watermark-remover

Pinned commit reviewed: `96dd835d4c694daf847a906a0ddb06f7d000a5bf`

Useful traits:

- Very small browser-first application surface.
- Video processing stays local and uses browser media primitives rather than a server upload workflow.
- Simple tuning controls and a direct process/download path make it easy to deploy.
- Includes Gemini alpha reference assets and inverse-alpha style cleanup logic.

Trade-offs observed:

- Much of the application and processing logic is concentrated in a large `main.js`.
- Geometry/threshold tuning is comparatively hard-coded.
- There is less separation between detection, restoration, export, tests, and benchmarking.

## Reference B - GargantuaX/gemini-watermark-remover

Pinned commit reviewed: `a771bc28df7e6af97dd862d5f293157207ba6d58` (`v1.0.39`).

Useful traits:

- Strong module separation: watermark catalog, detector, alpha profile logic, cleanup backends, video export, SDK and tests.
- Multi-frame video detection with a 12-frame default sampling strategy.
- Known Veo geometry catalog for common 1080p, 720p and portrait layouts.
- Spatial + gradient evidence instead of trusting a single frame or fixed coordinate blindly.
- Per-shot/seed alpha concepts, confidence gating and per-frame alpha change caps.
- Inverse alpha restoration is the primary detail-preserving operation; residual cleanup is separate.
- MediaBunny/WebCodecs pipeline with audio packet passthrough when the source audio codec is MP4-compatible.
- BT.709 output metadata handling and explicit bitrate/export settings.
- Experimental denoise/FDnCNN work exists, but it is more complex and is not treated here as the default stable path.

## Decisions for this repository

The v1.0.0 implementation deliberately combines the strongest practical ideas while keeping the codebase small:

1. **Local-first browser app** - no mandatory upload/backend.
2. **12-frame detection by default** - reduces intro/fade false decisions.
3. **Resolution catalog + local coordinate refinement** - fast known anchors plus tolerance for relocation.
4. **Spatial + gradient correlation** - lightweight detector suitable for a browser worker.
5. **Fail-closed confidence gate** - low-confidence videos are skipped unless the user explicitly forces cleanup or supplies a manual region.
6. **Inverse-alpha restoration** - preserves texture better than blurring/inpainting an entire square.
7. **Adaptive alpha with a per-frame cap** - limits flicker and large correction jumps.
8. **Masked edge polish** - small residual cleanup only around template edges.
9. **Temporal correction stabilization** - blends correction deltas only on low-motion pixels.
10. **Scene-cut reset** - drops temporal state and alpha history when ROI luma changes sharply, approximating per-shot seeding without a heavy shot detector.
11. **MediaBunny + WebCodecs MP4 export** - avoids shipping FFmpeg WASM for the normal browser path.
12. **Audio passthrough** - source encoded audio packets are copied when the codec is supported by MP4 output.
13. **Manual override** - gives a recovery path for unseen Gemini/Veo watermark positions.

## Explicit non-goals for v1.0.0

- Removing or defeating invisible provenance technologies such as SynthID.
- Claiming perfect detection across future Gemini/Veo watermark variants.
- Making experimental ML/FDnCNN denoise the default before it has a representative regression set.
- Uploading user videos to a third-party server.

## Future variant support

The GargantuaX research tree also contains rectangular Veo text-watermark templates. They are intentionally not enabled in v1.0.0 because this repository does not yet have a representative regression set for those templates. The detector/export architecture is modular so this can be added as a separately tested variant rather than weakening the square-overlay path.
