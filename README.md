# GAEMBOY 3DS Web

Nintendo 3DS emulation in the browser: the [Azahar](https://github.com/azahar-emu/azahar) emulator
(libretro core) compiled to WebAssembly with Emscripten, a WebGL2 hardware renderer running in a
Web Worker on an `OffscreenCanvas`, and threaded emulation through `SharedArrayBuffer`.

Part of the [GAEMBOY](https://github.com/DomenicoGonnelli) project. This repository is a
standalone program, released under the **GNU GPL v3 or later**, the same license as Azahar.

> **No games, BIOS, firmware or keys are included or downloaded.** Only use decrypted dumps of
> cartridges you own, or homebrew software. This project is not affiliated with or endorsed by
> Nintendo. "Nintendo 3DS" is a trademark of Nintendo.

## Status

Proof of concept that works on desktop browsers.

| | |
|---|---|
| Browsers | Chrome / Edge (WebGL2 renderer, recommended). Safari uses the software renderer by default. |
| Performance | On an Apple M2 Pro, homebrew and heavy commercial titles run at or near full speed in Chrome. |
| Mobile | Phone browsers are too slow, because WebAssembly has no ARM JIT. Use a native Android build of Azahar instead. |
| Formats | Decrypted `.3ds` / `.cci` / `.cxi` / `.app`, homebrew `.3dsx` / `.elf`. The file is read locally in chunks and never uploaded. |
| Saves | Persisted in the browser (IndexedDB). |

The full development log, with benchmarks, problems found and fixes, is in Italian in
[docs/DEV-NOTES-it.md](docs/DEV-NOTES-it.md).

## Repository layout

| Path | Content |
|---|---|
| `azahar-web/patches/azahar.patch` | All changes to Azahar: Emscripten/WASM port, WebGL2 renderer adaptations, FastInterp fixes. |
| `azahar-web/patches/libressl.patch` | Small build fix for the bundled LibreSSL. |
| `azahar-web/frontend/` | C++ web frontend (libretro host, audio, input, frame loop). |
| `azahar-web/web/` | Web page, emulation worker, audio worklet. |
| `azahar-web/scripts/` | `fetch-azahar-full.sh` (pinned sources and patches), `build.sh`, `serve.py` (dev server with COOP/COEP headers), `deploy-pages.sh`, `cia2cci.py`. |
| `cpu-bench/` | ARM11 interpreter benchmark used to assess feasibility (FastInterp vs DynCom in WASM). |
| `docs/` | Development notes. |

## Build

Requirements: [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
(installed in `~/emsdk`, or set `EMSDK`), CMake, Ninja, Python 3, git.

```sh
azahar-web/scripts/fetch-azahar-full.sh   # Azahar @ pinned commit + submodules + patches (~210 MB)
azahar-web/scripts/build.sh               # -> azahar-web/dist/
python3 azahar-web/scripts/serve.py 8766  # http://localhost:8766/
```

The page needs **cross-origin isolation** for `SharedArrayBuffer`. Any production host must
send these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

For this reason the emulator should run as its own top-level page (for example on a dedicated
subdomain) rather than inside an iframe of a site without these headers.

Static hosts that cannot set headers (for example GitHub Pages) are supported through
`web/coi-sw.js`: a service worker that adds the headers and reloads the page once. Hosts that
already send the headers never register it.

### GitHub Pages

Live demo: <https://domenicogonnelli.github.io/gaemboy-3ds-web/>

```sh
azahar-web/scripts/build.sh
azahar-web/scripts/deploy-pages.sh   # pushes dist/ to the gh-pages branch, recording the source commit
```

Only redistributable demo homebrew (Craftus Reloaded, MIT) is published next to the build.

URL options: `?sw` forces the software renderer, `?cpu=N` underclocks the emulated CPU (percent).

## Source code for deployed builds

Every deployed build corresponds to a tagged commit of this repository. The complete
corresponding source code is:

- this repository at that tag;
- Azahar at the commit pinned in `azahar-web/scripts/fetch-azahar-full.sh`, plus the patches above;
- the third-party libraries fetched by that script, under their own licenses.

The "Codice sorgente" link in the page footer points here.

## Credits and licenses

See [CREDITS.md](CREDITS.md). This program is free software: you can redistribute it and/or
modify it under the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version. See
[LICENSE](LICENSE).
