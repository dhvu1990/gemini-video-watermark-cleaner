# Publish to GitHub

Suggested repository: `dhvu1990/gemini-video-watermark-cleaner`

This source tree is ready to publish. From a machine with Git and GitHub CLI authenticated as `dhvu1990`:

```bash
git init
git add .
git commit -m "feat: initial Gemini video watermark cleaner v1.0.0"
gh repo create dhvu1990/gemini-video-watermark-cleaner --public --source=. --remote=origin --push
```

If you prefer a private repository, replace `--public` with `--private`.

After publishing, GitHub Actions will run syntax checks, unit tests, pinned alpha synchronization and the Vite build.
