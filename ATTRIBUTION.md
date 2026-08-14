# Third-party attribution

This project is an independent implementation. It does not bulk-copy either reference repository. It does, however, build on public technical ideas and an optional synchronized alpha-profile dataset from MIT-licensed work.

## GargantuaX/gemini-watermark-remover

Reference repository: `GargantuaX/gemini-watermark-remover`
Pinned research/setup commit: `a771bc28df7e6af97dd862d5f293157207ba6d58`

The setup script synchronizes the embedded Gemini/Veo alpha profiles `48`, `96`, and `96-20260520` from `src/core/embeddedAlphaMaps.js` at that pinned commit. These profiles are used as restoration templates. The application has a procedural fallback so source checkout remains usable even before synchronization.

Upstream license notice:

> MIT License  
> Copyright (c) 2025 Jad  
> Copyright (c) 2024 AllenK (Kwyshell)

The full MIT permission and warranty text is available in the upstream repository and is preserved by this attribution notice together with this project's MIT license.

## ishara-madu/gemini-watermark-remover

Reference repository: `ishara-madu/gemini-watermark-remover`
Pinned research commit: `96dd835d4c694daf847a906a0ddb06f7d000a5bf`

This implementation takes architectural inspiration from the upstream project's lightweight, local-first browser workflow and straightforward video UX. No upstream asset is synchronized from this repository.

Upstream license notice:

> MIT License  
> Copyright (c) 2026 Ishara Madushanka

## MediaBunny

Media container demux/mux and WebCodecs integration are provided through the `mediabunny` npm dependency under its own license. See the installed package for its license and notices.
