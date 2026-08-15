# Windows One-Click Launcher

Version: v1.0.29

This launcher is for the private deployment model:

- GitHub Free
- private repository
- GitHub Codespaces
- private forwarded port 5173
- no backend and no public Pages site required

## What it does

Double-clicking the Desktop shortcut will:

1. Use the authenticated GitHub CLI account on Windows.
2. Find the most recently used Codespace for `dhvu1990/gemini-video-watermark-cleaner`.
3. Start the Codespace through the official GitHub Codespaces API when it is stopped.
4. Poll until the Codespace reaches `Available`.
5. Wait for forwarded port `5173`.
6. Enforce `private` visibility on that port if necessary.
7. Read the current dynamic `browseUrl` instead of hard-coding a Codespace URL.
8. Open the private cleaner in the default browser.

No GitHub token or PAT is embedded in the launcher files.

## First-time installation

Download or copy the three files in `tools/windows/` to the same local folder:

- `Install-GeminiCleaner.ps1`
- `GeminiCleaner.ps1`
- `GeminiCleaner.cmd`

Then open PowerShell in that folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Install-GeminiCleaner.ps1
```

The installer will:

- detect GitHub CLI (`gh`);
- install GitHub CLI with `winget` if it is missing;
- open GitHub browser authentication if needed;
- ensure the `codespace` OAuth scope is granted;
- copy the launcher to `%LOCALAPPDATA%\GeminiVideoWatermarkCleaner`;
- create `Gemini Video Watermark Cleaner.lnk` on the Desktop.

## Daily use

Double-click:

`Gemini Video Watermark Cleaner`

If the Codespace is already running, the browser should open quickly. If it is stopped, the launcher starts it automatically and waits until it is ready.

## Security properties

- Repository remains private.
- The launcher requires the user's own GitHub authentication.
- Port 5173 is checked and forced to `private` before opening.
- The launcher obtains the live `browseUrl`; it does not store the temporary `*.app.github.dev` URL.
- No PAT is stored in the script.
- Video processing remains local in the browser after the private tool is opened.

## Troubleshooting

### `GitHub CLI is not authenticated`

Run:

```powershell
gh auth login --hostname github.com --web
```

Then rerun the installer so it can grant the Codespaces scope.

### No Codespace found

Create one Codespace once from the repository's `main` branch. After that, the launcher can discover and reuse it.

### Codespace starts but port 5173 does not appear

Open the Codespace and check:

```bash
curl -I http://127.0.0.1:5173
```

The v1.0.28+ devcontainer launcher should return `HTTP/1.1 200 OK`. If the browser proxy is stale, stop forwarding port 5173 and add it again as HTTP/Private.

### Multiple Codespaces exist for the repo

The launcher selects the most recently used Codespace. Delete unused duplicates from GitHub Codespaces if you want deterministic selection.

## Uninstall

Delete:

- Desktop shortcut `Gemini Video Watermark Cleaner.lnk`
- `%LOCALAPPDATA%\GeminiVideoWatermarkCleaner`

This does not delete the GitHub Codespace or repository.
