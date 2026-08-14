# Changelog

## 1.0.18 - 2026-08-15

- Added a **micro edge finishing pass** after the existing normal-direction edge bridge to target only the final thin Gemini diamond outline observed in real-video validation of v1.0.17.
- The finishing mask is deliberately narrower than the main edge bridge: it emphasizes the strongest edge-ring pixels, reduces feather influence, and strongly suppresses high-alpha core pixels.
- Reuses the calibrated alpha-gradient normal plus outer-background and inner-restored anchors so the final correction bridges across the residual outline instead of blurring the ROI.
- Added residual gating so pixels are only adjusted when the current result still differs meaningfully from the predicted bridge color.
- Added tighter structure guards, shorter anchor spans, a smaller per-channel correction cap, and a lower maximum blend than the primary edge bridge.
- Integrated the finishing pass inside the existing `applyNormalEdgeBridge()` path so detection preview and full-video export automatically share the same behavior without duplicating processing logic.
- Added diagnostics for `finishingPixels` and `finishingMeanBlend` alongside the existing edge-bridge statistics.
- Added a regression test requiring the thin residual edge to move closer to the clean reference while the high-alpha core changes by less than one intensity level on average.
- Kept v1.0.17 subpixel registration, residual-bucket calibration, detail-preserving core, padded repair, atlas, temporal stabilization and detector geometry unchanged.
- Updated visible/package version to v1.0.18.
- Detailed journal: `logs/2026-08-15-v1.0.18-edge-finishing-pass.md`.

## 1.0.17 - 2026-08-14

- Added two-stage **subpixel alpha registration** after coarse calibration.
- Tightened shape-scale search to `0.985 / 1.000 / 1.015` now that real-video validation shows the remaining artifact is primarily a thin edge mismatch rather than a large footprint error.
- Added bounded fractional alpha offsets `-0.4 / 0 / +0.4 px` independently in X and Y, evaluated only around the coarse winner to keep browser analysis practical.
- Added bilinear alpha-map registration without moving the source video or integer detector box.
- Split calibration diagnostics into `nearZero`, `edge`, `lowBody`, and `highBody` residual buckets; the combined objective weights the edge bucket most strongly while still penalizing core/outside damage.
- Added Tune-panel diagnostics for selected Offset X/Y plus Edge / Low-body / High-body residual values.
- Preserved the v1.0.16 hybrid detail core, padded repair, multi-frame atlas, normal-direction edge bridge and temporal stabilization pipeline.
- Added regression tests for fractional alpha movement and residual-bucket isolation.
- Updated UI/package/export metadata to v1.0.17.
- Detailed journal: `logs/2026-08-14-v1.0.17-subpixel-alpha-registration.md`.

## 1.0.16 - 2026-08-14

- Added **normal-direction edge bridge** repair after real-video validation showed v1.0.15 preserved the core well but still left a thin Gemini diamond outline.
- Edge-ring pixels use the alpha-gradient normal to find an outer clean-background anchor and an inner restored/core anchor, then interpolate across the residual edge rather than blurring the whole ROI.
- Added structure guards when inner/outer anchors disagree strongly so real scene edges are not flattened.
- Kept high-alpha core pixels protected by the v1.0.15 hybrid mask.
- Shared the edge-bridge path between detection preview and full-video export.
- Added diagnostics in export metadata and regression tests for halo reduction, core preservation and strong-structure protection.
- Detailed journal: `logs/2026-08-14-v1.0.16-normal-edge-bridge.md`.

## 1.0.15 - 2026-08-14

- Changed cleanup from whole-footprint reconstruction to a hybrid core/ring strategy after real-video validation showed v1.0.14 blurred high-frequency texture inside the watermark more than v1.0.12.
- Added an explicit hybrid repair mask with three soft regions: high-alpha detail-preserving core, feather transition, and aggressive edge ring.
- Padded spatial texture repair now applies strongly to the edge ring, moderately to the feather region, and only minimally to the core.
- Temporal donor reconstruction now follows the same region weighting so donor pixels cannot flatten the watermark center simply because motion alignment is confident.
- Multi-frame atlas blending is now constrained by an independent hybrid alpha/gradient mask; even high-confidence donor consensus is nearly disabled in the core and remains strongest at low-alpha/gradient edges.
- Kept inverse-alpha restoration and calibrated Body gain as the primary reconstruction path for core detail.
- Added regression tests that require core pixel changes to remain small while edge-ring pixels receive substantially stronger atlas correction.
- Added regression tests that verify spatial repair improves a damaged edge footprint without flattening the high-alpha core.
- Kept detector/catalog geometry, residual-gated full scan, padded ROI, scene-cut reset, Web Worker pipeline and local export architecture unchanged.
- Visible package/UI version bumped to v1.0.15.
- Detailed journal: `logs/2026-08-14-v1.0.15-hybrid-detail-edge-cleanup.md`.

## 1.0.14 - 2026-08-14

- Added a bounded multi-frame background atlas for watermark reconstruction after full detection/calibration.
- Atlas motion-aligns up to 8 recent padded ROI frames using clean border pixels around the watermark.
- Raw-frame preview donors remain conservative and only contribute pixels outside the fixed watermark mask.
- Full-video export stores previously repaired padded frames and can use masked donor consensus only when at least 3 aligned donors agree, allowing the atlas to reconstruct deeper parts of the watermark footprint rather than just the outer edge.
- Donor colors are combined with a per-channel median so one bad donor or residual artifact has less influence than single-frame copying.
- Atlas confidence combines donor support count and motion-alignment improvement; low-support pixels fall back to the existing padded spatial repair instead of being forced.
- Scene cuts and skipped low-confidence frames clear the atlas history so donors never cross shots.
- Export metadata now records how many frames used atlas support, the peak donor count, and history limit.
- Added synthetic tests for motion-shift estimation, safe raw donors, and cleaned-donor consensus inside the watermark footprint.
- Updated UI/package/export metadata to v1.0.14.
- Detailed journal: `logs/2026-08-14-v1.0.14-multi-frame-background-atlas.md`.

## 1.0.13 - 2026-08-14

- Added a residual-quality gate to progressive analysis: quick scans with calibration residual score above 18 automatically expand to the configured full scan even when position confidence is high.
- Added a 14 px padded ROI around the detected watermark so cleanup can use real surrounding texture instead of operating only inside the 72x72 watermark box.
- Added padded spatial texture reconstruction using horizontal, vertical and diagonal clean-alpha anchors with disagreement guards.
- Added temporal donor reconstruction that estimates small background translation from clean padded-border pixels and reuses previous-frame pixels only when the shifted donor lies outside the watermark footprint.
- Temporal donor repair skips static/weak-motion frames rather than copying the same watermarked coordinate.
- Detection preview and full-video export now share the same padded reconstruction path.
- Added tests for residual-gated quick scans, padded texture repair, temporal shift estimation and safe temporal-donor fallback.
- Updated export metadata and visible UI to v1.0.13.
- Detailed journal: `logs/2026-08-14-v1.0.13-padded-temporal-reconstruction.md`.

## 1.0.12 - 2026-08-14

- Added directional background reconstruction after inverse-alpha, edge polish and residual-footprint cleanup.
- Added one-sided outward repair for closed watermark outlines where only the exterior side reaches clean background.
- Added a 3x3 local structure guard to preserve strong real edges crossing the watermark ROI.
- Added regression coverage for reducing a synthetic residual halo while preserving a strong real structure.
- CI required several corrective iterations before all 25 tests and the production build passed; the full failure/fix history is recorded in `logs/2026-08-14-v1.0.12-directional-background-reconstruction.md`.

## 1.0.11 - 2026-08-14

- Fixed the real-video v1.0.10 regression where calibration could over-darken the watermark center while leaving the diamond outline visible.
- Body gain is now calibrated independently before the profile/shape/edge search instead of being fixed to the detector's initial opacity estimate.
- Added body-gain candidates below the initial estimate so calibration can recover from aggressive detector gain estimates.
- Replaced the dominant residual-edge objective with a background-continuity objective that compares cleaned watermark pixels against interpolated low-alpha background anchors.
- Added penalties for clipped/over-dark center pixels and for modifying pixels outside the watermark footprint.
- Kept the bounded 54-candidate profile/shape/edge search after body-gain selection.
- Detection now exposes both `estimatedAlphaGain` and the final calibrated `alphaGain` for diagnostics.
- Adaptive export gain is clamped to ±0.06 around the calibrated Body gain and changes by at most ±0.025 per frame to prevent gain drift.
- Updated export metadata to v1.0.11 and ensured detection receives the configured Edge polish value during calibration.
- Added regression tests for lower body-gain search and over-clean/dark-center scoring.
- Kept watermark position/catalog geometry unchanged.

## 1.0.10 - 2026-08-14

- Added automatic **alpha-shape calibration** after a watermark is detected.
- Calibration evaluates 54 bounded combinations across two embedded alpha profiles, three shape scales, three edge-boost values, and three edge-gain values using up to three sampled watermark ROIs.
- Added a residual-edge objective that favors lower remaining diamond-edge energy while penalizing visible changes outside the watermark footprint.
- Split cleanup strength conceptually into **Body gain** (existing adaptive alpha gain) and **Edge gain** (selected by calibration and applied preferentially to low-alpha/gradient regions).
- Added calibrated alpha-map persistence inside the current Web Worker so full-video export reuses the same selected map without recalibrating or decoding the video a second time.
- `ZOOMED CLEANED` now uses the selected calibrated alpha map, making the preview a direct quality check for the map that export will use.
- Added Tune-panel diagnostics for selected profile, shape scale, edge gain, edge boost, and residual score.
- Added calibration helper tests and extended syntax checks to the new calibration modules.
- Kept watermark position detection/catalog geometry unchanged from v1.0.9.

## 1.0.9 - 2026-08-14

- Added a dedicated **4. Result preview** panel below Export.
- The cleaned MP4 is now attached to an in-browser video player immediately after export completes so the result can be reviewed before downloading.
- Result playback uses the same local Blob URL as the existing **Download cleaned MP4** action; no additional upload or server round trip is introduced.
- Added normal browser video controls for play/pause, seek, volume and fullscreen where supported.
- Automatically scrolls to the result panel after a successful export.
- Selecting a new source video or starting another cleanup pass now pauses/resets the old result player and revokes its previous Blob URL to avoid stale playback and retained browser memory.
- Kept v1.0.8 detector, alpha, edge cleanup and export algorithms unchanged; this release is a result-review UX addition only.

## 1.0.8 - 2026-08-14

- Added a rotating spinner to the analysis button while automatic quick/full detection is running so long analysis is visibly active.
- Reduced the quick scan from 4 frames / first 25% of the video to 3 frames / first 18%, while making the quick acceptance threshold and vote requirement stricter; uncertain results still expand automatically to the full scan.
- Made portrait Auto Detection Preview more compact and visually balanced with the two Original/Cleaned zoom cards without changing detector coordinates.
- Kept the validated v1.0.7 detector geometry path unchanged; cleanup quality changes are isolated to post-detection processing.
- Added cleanup-only low-alpha edge enhancement inspired by upstream Gemini video alpha-profile research.
- Added structure-guarded residual footprint cleanup after edge polish to reduce the visible diamond outline that remained after inverse-alpha restoration.
- The same post-restoration cleanup path is used for the `ZOOMED CLEANED` preview and exported video.
- Added tests for the new quick-scan policy, low-alpha edge enhancement, and residual footprint cleanup.
- Did not add ML/FDnCNN to the default runtime; v1.0.8 remains a lightweight browser implementation.

## 1.0.7 - 2026-08-14

- Fixed the full-frame Auto Detection Preview bounding box being visually offset from the actual Gemini watermark on portrait videos.
- Root cause: the preview stage was assigned the source aspect ratio but also capped with `max-height: 680px`, which distorted the stage coordinate system while the overlay still used source-frame percentages.
- Removed the conflicting height cap and made the preview video absolutely fill a stage whose geometry is controlled only by the source aspect ratio.
- Detector coordinates, zoomed original ROI, zoomed cleaned ROI, and cleanup geometry are unchanged; this release fixes preview rendering alignment only.
- Bumped the visible application and package version to `v1.0.7`.

## 1.0.6 - 2026-08-14

- Changed the default UX from manual **Analyze watermark** to automatic detection immediately after selecting a video.
- Added progressive detection: a 4-frame quick scan over only the first 25% of the video, followed automatically by the normal full scan only when the quick result is not strong enough.
- Added a full-frame video preview with the detected watermark bounding box overlaid directly on the video.
- Added **ZOOMED ORIGINAL** and **ZOOMED CLEANED** ROI previews generated from a representative sampled frame in the Web Worker.
- Added a stricter quick-scan acceptance policy so fast detection does not trade away confidence silently.
- Split detection metadata from export statistics so normal detection no longer computes packet-rate statistics that are only needed later for export.
- Reused the already detected region during cleanup/export, avoiding a second full watermark-analysis pass after the user has already reviewed a successful detection.
- Renamed the manual detector button to **Re-analyze full video**.
- Added progressive-analysis unit tests and extended syntax checks to cover the new analysis policy module.
- Updated the visible application title/badge to `v1.0.6` and documented the real-browser performance regression that motivated this release.

## 1.0.5 - 2026-08-14

- Fixed deployed-browser file selection appearing to hang when Chrome/Windows provides an empty or non-standard MIME type for a Gemini/Veo video.
- Video validation now accepts supported files by either `video/*` MIME type or `.mp4`, `.mov`, `.m4v`, and `.webm` extension fallback.
- Replaced the hidden label-only picker with an explicit **Choose video** button while preserving drag-and-drop.
- File validation errors now appear immediately beside the selector.
- Added file-validation unit tests and updated the visible application version.

## 1.0.4 - 2026-08-14

- Recorded successful v1.0.3 CI validation and squash merge.
- Recorded the first production Pages deployment attempt and the one-time Pages enablement blocker.
- GitHub Pages was subsequently enabled and deployment completed successfully before merge.

## 1.0.3 - 2026-08-14

- Added GitHub Pages production deployment workflow and deployment runbook.
- Updated CI Actions versions and kept Vite relative asset paths for the project-site subpath.

## 1.0.2 - 2026-08-14

- Recorded successful v1.0.1 CI validation/merge state and continued the permanent project execution log.

## 1.0.1 - 2026-08-14

- Fixed CI startup failure caused by npm cache configuration without a committed lockfile.
- Added the dedicated project execution log.

## 1.0.0 - 2026-08-14

- Initial independent release.
- Added browser-local MediaBunny/WebCodecs video pipeline, multi-frame detection, inverse-alpha restoration, adaptive alpha, confidence gate, edge polish, temporal stabilization, audio passthrough, manual override, tests and CI.
