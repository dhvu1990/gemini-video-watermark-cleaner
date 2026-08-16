# Private GitHub Codespaces Runtime

This repository runs as a private browser tool in GitHub Codespaces without a separate backend.

## Primary runtime

```text
Private GitHub repository
  -> GitHub Codespace
  -> Vite on port 5173
  -> private forwarded port
  -> authenticated owner browser
  -> video processing remains local in that browser
```

GitHub Pages is not the primary runtime for this private project.

## Current usage

The application is opened through the Codespaces forwarded URL for port `5173`, for example:

```text
https://<codespace-name>-5173.app.github.dev/
```

A concrete `*.app.github.dev` hostname is temporary and can change when a Codespace is recreated. Do not hard-code it into application source or documentation as a permanent production hostname.

The Windows launcher discovers the current Codespace and live `browseUrl` dynamically.

## What the dev container does

`.devcontainer/devcontainer.json` uses Node.js 22 and automatically:

1. installs npm dependencies,
2. runs `npm run setup:alpha` to sync the pinned alpha profiles,
3. forwards port `5173`,
4. starts Vite on `0.0.0.0:5173` whenever the Codespace starts.

Keep the forwarded port visibility set to **Private** in the Codespaces Ports panel.

## Normal verification after a merge to main

1. Update/rebuild the Codespace from `main` if required.
2. Confirm Vite is running on port `5173`.
3. Confirm the port visibility is **Private**.
4. Open the current forwarded `browseUrl`.
5. Confirm the app version/runtime loads correctly.
6. Test a local Gemini/Veo video in the browser.
7. Review `ZOOMED ORIGINAL`, `ZOOMED CLEANED`, and the exported result before accepting cleanup quality.

## Manual commands

If automatic startup is unavailable:

```bash
npm install --no-audit --no-fund
npm run setup:alpha
npm run dev -- --host 0.0.0.0 --port 5173
```

## Troubleshooting

### Port 5173 is not listed

Run:

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

Then use **Forward a Port** in the Ports panel and enter `5173`.

### Alpha setup failed

Run:

```bash
npm run setup:alpha
```

Then verify the generated alpha payload exists before restarting Vite.

### Codespace restarted but Vite is not running

Inspect:

```bash
cat /tmp/gemini-vite.log
```

Then restart manually with the Vite command above.

## Security rule

Do not change forwarded port visibility to Public. The private Codespaces URL on port `5173` is the intended personal runtime.
