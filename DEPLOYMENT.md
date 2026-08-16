# Deployment / Runtime Runbook

## Primary target

This private project is run through **GitHub Codespaces**, not GitHub Pages.

```text
Private repository
-> GitHub Codespace
-> Vite dev server on port 5173
-> private forwarded port
-> authenticated browser session
```

The application remains local-first: selected video bytes are processed in the browser. The Codespace serves the application files and bundled alpha-profile data.

## Current runtime pattern

A live session uses a GitHub Codespaces URL similar to:

```text
https://<codespace-name>-5173.app.github.dev/
```

The hostname is dynamic and may change when the Codespace is recreated. Treat port `5173` and private Codespaces forwarding as the stable architecture, not any one temporary hostname.

## Repository state

- Repository: `dhvu1990/gemini-video-watermark-cleaner`
- Visibility: private
- Default branch: `main`
- Runtime: GitHub Codespaces
- Runtime port: `5173`
- Port visibility: **Private**
- Dev container: `.devcontainer/devcontainer.json`
- Startup helper: `.devcontainer/start-vite.sh`

## Normal update flow

After a change is merged to `main`:

1. Confirm CI passes.
2. Pull/update or rebuild the active Codespace from `main` as needed.
3. Confirm `npm run setup:alpha` has completed successfully.
4. Confirm Vite is healthy on `127.0.0.1:5173` inside the Codespace.
5. Confirm port `5173` is forwarded as **Private**.
6. Open the current Codespaces `browseUrl`.
7. Load a real local Gemini/Veo sample.
8. Review detection, `ZOOMED ORIGINAL`, `ZOOMED CLEANED`, and the final exported MP4.

## Dev-container startup

The dev container uses Node.js 22. On creation it runs:

```bash
npm install --no-audit --no-fund
npm run setup:alpha
```

On each Codespace start, `.devcontainer/start-vite.sh` starts:

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

The helper checks local health and writes Vite output to `/tmp/gemini-vite.log`.

## Manual health checks

Inside the Codespace:

```bash
curl -I http://127.0.0.1:5173/
cat /tmp/gemini-vite.log
```

Expected result: the local HTTP request succeeds and the forwarded private port opens the application in the authenticated browser.

## Production validation commands

CI and manual validation still use the normal static build pipeline:

```bash
npm install --no-audit --no-fund
npm run setup:alpha
npm run check
npm test
npm run build
```

A successful Vite build remains useful for regression validation even though the day-to-day private runtime is the Codespaces dev server.

## GitHub Pages history

Earlier project versions attempted GitHub Pages deployment. Those attempts proved the application could build successfully, but Pages required repository-level enablement and was later superseded by the private Codespaces deployment model.

As of v1.0.33, GitHub Pages is not considered a runtime dependency or release blocker for this project. The old automatic Pages workflow is removed so pushes to `main` do not generate irrelevant failed deployment runs.

## Windows launcher

`tools/windows/GeminiCleaner.ps1` discovers the most recently used Codespace for this repository, starts it when necessary, waits for port `5173`, enforces private visibility, reads the live `browseUrl`, and opens it in the default browser.

The launcher intentionally does not hard-code a `*.app.github.dev` URL.

## Security rules

- Keep the repository private.
- Keep Codespaces port `5173` private.
- Do not publish the forwarded port publicly.
- Do not store customer/private videos in the repository.
- Do not hard-code GitHub credentials, PATs, or temporary Codespaces URLs.

## Regression evidence

For meaningful real-video tests, record:

- release version,
- input resolution and duration,
- detected geometry and confidence,
- calibration values,
- selected cleanup/background mode,
- visible residual quality,
- audio result,
- browser/version,
- any artifact or regression,
- follow-up action if needed.
