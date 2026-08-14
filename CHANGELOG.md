# Changelog

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
