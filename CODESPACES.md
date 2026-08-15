# Private GitHub Codespaces Runtime

This repository can run as a private browser tool in GitHub Codespaces without a separate backend.

## Target architecture

```text
Private GitHub repository
  -> GitHub Codespace
  -> Vite on port 5173
  -> private forwarded port
  -> authenticated owner browser
  -> video processing remains local in that browser
```

## What the dev container does

`.devcontainer/devcontainer.json` uses Node.js 22 and automatically:

1. installs npm dependencies,
2. runs `npm run setup:alpha` to sync the pinned alpha profiles,
3. forwards port `5173`,
4. starts Vite on `0.0.0.0:5173` whenever the Codespace starts.

No public port visibility is configured in the repository. Keep the forwarded port visibility set to **Private** in the Codespaces Ports panel.

## First test while the repository is still public

1. Open the repository on GitHub.
2. Select **Code -> Codespaces -> Create codespace on main** after v1.0.27 is merged.
3. Wait for the post-create setup to finish.
4. Open the **Ports** panel.
5. Verify port `5173` exists and visibility is **Private**.
6. Open the forwarded URL.
7. Confirm the app loads and select a local test video.
8. Re-test both baseline samples:
   - USB-C / empty background path,
   - keyboard / structured background path.
9. Confirm video bytes are still selected from the browser and the app remains local-first.

## Before changing the repository to Private

- Confirm CI is green on v1.0.27.
- Confirm the Codespace starts automatically.
- Confirm port `5173` is Private.
- Confirm both regression videos behave like v1.0.26.
- Save the milestone notes/config to the Google Drive project archive.

## After changing the repository to Private

Create or rebuild the Codespace from the private repository and repeat the checks above. The GitHub Pages production site is no longer the target runtime for the private-only deployment.

## Manual commands

If automatic startup is ever unavailable:

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

Do not change forwarded port visibility to Public. The private Codespaces URL is the intended personal runtime after repository privatization.
