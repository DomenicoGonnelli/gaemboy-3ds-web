# GAEMBOY 3DS LAB — emulazione Nintendo 3DS nel browser

**Data:** 15–16 novembre 2026 · **Base:** Azahar `11eceda` (master 12/11/2026) · **Macchina:** Apple M2 Pro

- **POC 1 — CPU ARM11 in WebAssembly** ([`cpu-bench/`](cpu-bench)): il **rischio n.1** dello studio
  (*"CPU/JIT → WASM: molto alto"*). Un interprete ARM11 in WASM regge il tempo reale di un 3DS?
- **POC 2 — Azahar completo in WebAssembly** ([`azahar-web/`](azahar-web)): il *checkpoint fondamentale*
  dello studio, cioè sorgente → Emscripten → `.wasm` → Chrome → software locale → **BOOT → GAMEPLAY**.
- **POC 3 — Renderer hardware WebGL2** ([`azahar-web/`](azahar-web)): il renderer OpenGL di Azahar adattato a
  WebGL2 (GLES 3.0) su `OffscreenCanvas` in un Web Worker.

## POC 2 — Azahar completo nel browser: **BOOT e GAMEPLAY riusciti**

| | Risultato |
|---|---|
| Build WASM | **Sì.** L'intero Azahar (kernel e servizi HLE, FastInterp, PICA200 con renderer software, audio HLE, FS) compila con Emscripten con **patch piccole** (`azahar-web/patches/`: 11 file, +86/−12 righe), in un unico `gaemboy3ds.wasm` da **10 MB**. |
| Boot | **Sì**: *Super Haxagon* 3.9.1 (homebrew GPL, `.3dsx` ufficiale) si carica in ~120 ms e gira in Chrome e Safari/WebKit. |
| Rendering | **Corretto**, dopo aver aggiunto ad Azahar il supporto alla *wide mode* 800 px, che mancava in tutti i renderer di Azahar (il gioco stesso lo dichiara nei sorgenti). |
| Input | **Funziona**: tastiera → pulsanti 3DS (navigazione nei menu e cambio livello verificati); il touch passa dal puntatore libretro. |
| Velocità (M2 Pro) | Titolo **~54 fps (90%)**, menu di gioco **~41 fps (69%)**. Identica in Chrome e WebKit. |
| Test 3D (senza audio) | *Craftus Reloaded* 0.3 (MIT, citro3d, nessun audio): menu touch, creazione del mondo, **mondo 3D a blocchi renderizzato correttamente**, camminata, rotazione col Circle Pad e cambio blocco funzionano. **~16 fps (27%)**, 61 ms per frame. |
| Dove va il tempo | CPU emulata (FastInterp) **2–3%**. **Renderer software PICA200 ≈ 80%** sia in 2D sia in 3D: su un thread solo Super Haxagon farebbe 12 fps. Nel mondo 3D di Craftus: rasterizzazione 37% + attesa dei worker 37% + sincronizzazione 7%, shader PICA 6%. |
| Audio | Non verificato: gli homebrew libctru avviano l'audio solo con `sdmc:/3ds/dspfirm.cdc` (firmware DSP Nintendo, non distribuibile). |
| Verdetto POC 2 | **Architettura validata** (core, thread, FS, input, frame). Col renderer software la GPU pesa ~80–90%. |

## POC 3 — Renderer hardware WebGL2: **6× più veloce nel 3D**

| | Software (POC 2) | **WebGL2 (POC 3)** |
|---|---|---|
| Super Haxagon (2D, tempo/frame) | 23–25 ms (~41–54 fps) | **0,9–1,0 ms** (~53–60 fps) |
| Craftus Reloaded (mondo 3D, tempo/frame) | 61,5 ms (~16 fps) | **9,8 ms in Chrome, 3,8 ms in WebKit** (**6×–16× più veloce**, sotto il budget di 16,7 ms) |
| Architettura | `PROXY_TO_PTHREAD` + blit RGBA CPU | `OffscreenCanvas` trasferito al Web Worker, WebGL2 diretto (zero copie pixel) |
| Fallback | — | `?sw` nell'URL riattiva il renderer software per confronto |

Modifiche principali in `azahar-web/patches/azahar.patch`:
- `gl_shader_util.cpp`: adattamento GLSL 320/430 → `#version 300 es` (rimozione `layout(binding/location)` su uniform e varying, `out gl_PerVertex`, `#define fma`), binding esplicito di UBO (`vs_pica_data`, `vs_data`, `fs_data`) e sampler al link.
- `gl_stream_buffer.cpp`: staging buffer CPU + `glBufferSubData` (WebGL2 non ha `glMapBufferRange`/`glBufferStorage`).
- `gl_rasterizer.cpp` + `glsl_fs_shader_gen.cpp` + `gl_state.cpp`: LUT (`lf`/`rg`/`rgba`) da `samplerBuffer` (`GL_TEXTURE_BUFFER`) a texture 2D `1024×H` (`FetchLut`), `glDrawRangeElementsBaseVertex` sostituito da rebase degli indici + `glDrawRangeElements`.
- `gl_shader_manager.cpp`: `use_geometry_shader = false` in `CalcExtraConfig` (WebGL2 non ha geometry shader; i vertex shader emettono direttamente verso il fragment shader).
- `gl_blit_helper.cpp` + `gl_texture_runtime.cpp`: `glProgramUniform*` → `glUseProgram`+`glUniform*`, `glCopyImageSubData` → `glBlitFramebuffer`/`glCopyTexSubImage2D`, guardie su MSAA/`glObjectLabel`/`uimage2D`.

Dettagli, metodo e come provarlo: [sezione POC 2](#poc-2--dettagli).

## POC 1 — CPU ARM11 in WebAssembly

### TL;DR POC 1

| | Risultato |
|---|---|
| L'interprete ARM11 compila e gira in WASM? | **Sì**: gli interpreti reali di Azahar (DynCom e FastInterp) compilano con Emscripten **senza modificarne il codice**. Tutti i checksum corrispondono al riferimento nativo. |
| Velocità in browser (desktop M2 Pro) | **FastInterp: 130% del tempo reale 3DS in Chrome, 145% in Safari** (mix di carichi, CPU emulata al 100% di carico). |
| Velocità in browser (iPhone, Safari 27, HTTPS) | **FastInterp: 119% del tempo reale 3DS** (251 MIPS). È l'82% di Safari su M2 Pro, quasi alla pari con Chrome desktop. |
| Velocità in browser (Galaxy A71, Snapdragon 730, Chrome 157) | **FastInterp: 37%** (79 MIPS), stabile su 3 esecuzioni. Lo stesso codice nativo sul core A76 fa 80% (170 MIPS): su Android il WASM conserva solo il 46% del nativo. |
| Costo del passaggio a WASM | Si conserva il **67–75% della velocità nativa**. |
| DynCom (interprete classico Citra) | 65–66%: **insufficiente** (soprattutto in virgola mobile: 40%). |
| Verdetto CPU | **GO condizionato per desktop e iPhone recenti**: la CPU tiene il tempo reale con ~20–45% di margine, ma il margine va condiviso con GPU, audio e HLE. **NO-GO nel browser per Android di fascia media** (A71: 37%). |
| App Android nativa | **Strada giusta per Android**: sull'A71 anche il solo *interprete* nativo arriva all'80%. Con il JIT Dynarmic di Azahar il margine è molto più ampio. È la stessa architettura già usata per melonDS nativo. |

### Cosa è stato misurato

- **Codice CPU reale, non modificato**: `src/core/arm/{fastinterp,dyncom,skyeye_common}` di Azahar, compilati
  così come sono. Solo le dipendenze esterne (`Core::System`, `Memory`, `Timing`, kernel SVC, logging) sono
  sostituite da stub minimali in [`cpu-bench/stubs/`](cpu-bench/stubs). Le letture/scritture lente restano
  chiamate non inline, come nel `MemorySystem` vero.
- **Programma guest ARMv6K + VFPv2** (lo stesso target dell'ARM11 MPCore del 3DS), compilato con clang in un binario
  grezzo caricato a `0x00100000`, con stack a `0x10000000`. Comprende 9 carichi di lavoro tipici di un gioco: logica
  delle entità, lookup in tabelle, sort, trasformazioni di vertici in VFP, una VM a bytecode come i motori di
  script, copie di blocchi `ldm/stm`, varianti Thumb e un mix di tutto.
- **Correttezza**: lo stesso C è compilato anche per l'host. Ogni esecuzione emulata deve restituire lo stesso checksum,
  altrimenti fallisce. **Tutte le 9×2 esecuzioni sono corrette su nativo, Node, Chromium, Chrome e WebKit.**
- **Metrica "% tempo reale" (%RT)**: secondi di CPU 3DS emulati diviso secondi reali impiegati. I cicli emulati sono
  calcolati con la tabella cicli di Azahar (`arm_tick_counts`), cioè la stessa usata da Dynarmic per lo scheduling.
  **100% = un ARM11 a 268,1 MHz occupato al 100%.**
  I MIPS usano il conteggio istruzioni di DynCom, che conta 1 tick per istruzione.

### Risultati

%RT (MIPS). FI = FastInterp, DC = DynCom. JSON completi in [`cpu-bench/results/`](cpu-bench/results).

| Workload | Nativo FI | Chrome FI | Safari FI | **iPhone FI** | Nativo DC | Chrome DC | Safari DC | iPhone DC |
|---|---|---|---|---|---|---|---|---|
| entities (game logic) | 172% (388) | 110% (248) | 113% (254) | 83% (188) | 92% (207) | 57% (128) | 68% (154) | 38% (85) |
| crc32 (table lookups) | 181% (431) | 117% (278) | 127% (304) | 106% (252) | 96% (229) | 76% (181) | 81% (192) | 42% (100) |
| shellsort | 235% (341) | 183% (266) | 194% (281) | 153% (223) | 117% (169) | 98% (142) | 105% (153) | 60% (88) |
| vertex xform (VFP) | 469% (659) | 294% (413) | 335% (471) | 283% (398) | 51% (72) | 40% (57) | 44% (61) | 30% (43) |
| bytecode VM (script) | 204% (312) | 155% (236) | 159% (243) | 127% (194) | 92% (140) | 75% (115) | 75% (114) | 48% (74) |
| block copy (ldm/stm) | 251% (614) | 153% (373) | 175% (428) | 146% (357) | 91% (222) | 71% (174) | 79% (194) | 56% (138) |
| crc32 [thumb] | 187% (500) | 117% (314) | 135% (362) | 113% (304) | 92% (246) | 75% (201) | 71% (191) | 33% (87) |
| bytecode VM [thumb] | 156% (418) | 99% (266) | 119% (318) | 97% (259) | 66% (178) | 55% (146) | 53% (142) | 32% (85) |
| **mix** | **194% (409)** | **130% (274)** | **145% (307)** | **119% (251)** | 80% (169) | 66% (140) | 65% (137) | 39% (82) |

Nativo, Chrome e Safari sono misurati su M2 Pro. Nativo = Apple clang `-O3` arm64. Chrome 157 / Chromium 156
headless, WebKit 27.2 (motore di Safari) via Playwright. iPhone = il telefono dell'utente (il browser non espone il
modello), Safari 27.0.1 via HTTPS, JIT verificato attivo, test eseguito a mano: `wasm-iphone-safari.json`.
Node 22 (V8 meno recente) dà 107% sul mix, vedi `wasm-node.json`.

#### Samsung Galaxy A71 (Snapdragon 730), Android 11

Chrome 157 via `adb reverse` (`http://localhost`, contesto sicuro, JIT verificato), termica nominale (stato 0, 27 °C).
Nativo = stesso harness compilato con l'NDK (`build-host.sh android`) ed eseguito con `taskset` sui due core A76.
JSON: `wasm-galaxy-a71-chrome.json`, `native-galaxy-a71.json`.

| Workload | Chrome FI | Nativo A76 FI | Chrome DC | Nativo A76 DC |
|---|---|---|---|---|
| entities (game logic) | 30% (69) | 71% (160) | 14% (32) | 36% (81) |
| crc32 (table lookups) | 32% (77) | 74% (175) | 17% (40) | 37% (89) |
| shellsort | 55% (79) | 113% (164) | 25% (37) | 54% (79) |
| vertex xform (VFP) | 74% (104) | 184% (259) | 11% (16) | 19% (26) |
| bytecode VM (script) | 44% (67) | 90% (137) | 22% (34) | 41% (63) |
| block copy (ldm/stm) | 34% (84) | 90% (220) | 13% (33) | 34% (84) |
| crc32 [thumb] | 32% (86) | 80% (215) | 16% (42) | 35% (95) |
| bytecode VM [thumb] | 31% (82) | 69% (185) | 14% (39) | 28% (74) |
| **mix** | **37% (79)** | **80% (170)** | 17% (37) | 32% (68) |

Sui core lenti (A55, `taskset 3f`) il mix nativo scende a FI 24% (52 MIPS). Chrome (79 MIPS) quindi gira sul core
veloce. Il rapporto WASM/nativo sull'A71 è 0,46, contro 0,67–0,75 sul Mac.

### Lettura dei risultati

1. **Il "muro" CPU/JIT non è un muro.** Non serve inventare un percorso CPU: Azahar ha già FastInterp,
   un interprete a blocchi pre-decodificati con fusione di istruzioni, e lo usa automaticamente quando Dynarmic non
   è disponibile (`core.cpp`: `HAVE_FASTINTERP` + `use_fastinterp`). Compila in WASM così com'è, perché il
   computed goto viene abbassato a `br_table`.
2. **Il margine su desktop è reale ma non enorme.** 130–145% significa che, con la CPU emulata al 100%, restano
   ~25–30% del tempo per tutto il resto (PICA200, servizi HLE, DSP), oppure si possono usare altri thread.
   I giochi pesanti (Pokémon X/Y, Sole/Luna) caricano molto l'ARM11: su un desktop veloce sono **plausibili ma al
   limite**. I giochi 2D o leggeri hanno più margine.
3. **Mobile web — misurato su iPhone: meglio del previsto.** In Safari via HTTPS, FastInterp arriva al **119%** sul mix
   (251 MIPS), l'82% di Safari su M2 Pro, ed è sopra il 100% in 7 carichi su 9. Il punto debole è la logica entità
   (83%). Quindi su un iPhone recente il budget CPU è dello stesso ordine del desktop.
   Restano due incognite:
   - (a) **throttling termico**: il test dura ~20 s, una sessione di gioco molto di più;
   - (b) **Android di fascia media: misurato, ed è insufficiente.** Il Galaxy A71 (Snapdragon 730) fa **37%** in Chrome.
     La penalità dipende da due fattori: la CPU è ~3 volte più lenta di un iPhone recente, e il WASM su Android/V8
     conserva meno velocità (46% del nativo contro 67–75% sul Mac).

   Sul web mobile il 3DS è quindi realistico solo sugli iPhone recenti e, da verificare, sugli Android di fascia alta.
   Per la fascia media servirebbe un **JIT ARM→WASM** (blocchi ARM tradotti in moduli WebAssembly a runtime, come
   fanno v86 o Play! per PS2). Dovrebbe dare un ordine di grandezza in più, ed è R&D di mesi.
   La soluzione pratica per Android è l'app nativa: sull'A71 anche l'interprete nativo arriva all'80%.
4. **Safari/WebKit disattiva il JIT nei contesti non sicuri.** Su `http://<IP-LAN>`, che non è HTTPS né localhost,
   WebKit esegue JavaScript e WASM senza JIT: in un ciclo JS fa 36 M it/s contro ~950 su localhost o HTTPS, e FastInterp
   scende da ~290 a 9 MIPS. Chromium non lo fa. Lo stesso effetto si ha con la Modalità di isolamento di iOS.
   Conseguenze: la versione web va servita **solo in HTTPS** (GAEMBOY lo è già) e i test su iPhone vanno fatti in HTTPS.
   La pagina del benchmark ora rileva il JIT spento e segnala il risultato come non valido.
   Il primo test su iPhone (iOS, Safari 27 via `http://192.168.1.19`) aveva dato 3% RT / 6 MIPS proprio per
   questo, ed è stato riprodotto sul Mac.
5. **Memoria**: FastInterp usa ~11 MB di block cache (16384 blocchi × 664 B) più 4 MB di page table vuota.
   DynCom invece riserva staticamente 125 MiB di cache di traduzione: un'altra ragione per escluderlo in WASM.

### Prova sul telefono

La cartella `cpu-bench/build/web/` è statica e autosufficiente e non richiede SharedArrayBuffer. Per Safari su
iPhone/iPad **serve però HTTPS**, altrimenti il JIT resta spento (vedi sopra). Su Android con Chrome basta anche
`http://<IP-del-Mac>:8765/`.

```sh
cd cpu-bench/build/web && python3 -m http.server 8765 --bind 0.0.0.0 &
# HTTPS con certificato valido, senza account: tunnel temporaneo Cloudflare
mkdir -p ../../../tools && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar xz -C ../../../tools
../../../tools/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8765   # stampa https://<nome>.trycloudflare.com
# dal telefono: apri l'URL https -> "Avvia benchmark" -> "Copia risultati"
```

Se la copia automatica non è disponibile, i risultati compaiono comunque in un riquadro selezionabile.

Il verdetto in fondo alla pagina si basa sul mix FastInterp: ≥150% buono, 100–150% al limite, <100% insufficiente.

### Riprodurre

Servono `~/emsdk` (già presente), clang con backend ARM (Apple clang va bene) e Playwright per i browser.

```sh
./scripts/fetch-azahar.sh                      # sparse checkout ~4 MB, commit fissato
cd cpu-bench
./scripts/build-guest.sh                       # binario ARMv6K + checksum di riferimento
./scripts/build-host.sh native && ./build/native/cpu_bench build/guest/bench.bin build/guest/expected.txt
./scripts/build-host.sh node   && node build/node/cpu_bench.js build/guest/bench.bin build/guest/expected.txt
./scripts/build-host.sh web                    # -> build/web/ (pagina + worker + wasm)
./scripts/build-host.sh android                # nativo arm64 (NDK); adb push + taskset per i core veloci
(cd build/web && python3 -m http.server 8765) &
PLAYWRIGHT=/path/to/node_modules/playwright node scripts/run-browsers.mjs http://127.0.0.1:8765/
```

### Limiti del test

- Il benchmark è **sintetico**: niente MMIO, cambi di thread o eccezioni. I giochi veri passano più spesso dai
  percorsi lenti (I/O, SVC) e invalidano la cache. In un gioco ci si aspetta una velocità CPU un po' inferiore.
- Si misura solo la CPU. GPU, audio e servizi HLE restano da misurare nel POC 2.
- %RT al 100% presuppone un ARM11 sempre occupato (caso peggiore). Il carico reale di un gioco è inferiore.
- Non è incluso nessun materiale Nintendo (ROM, firmware, chiavi): il guest è codice nostro.

## POC 2 — dettagli

### Architettura

```text
Pagina (main thread)            Worker "host" (gaemboy3ds-worker.js)        pthread main + pool
 index.html + page.js            createGaemboy3DS()                          gaemboy3ds_web.cpp
 ├─ file utente (File) ──────▶   /rom      = WORKERFS (letture a blocchi) ◀─ fopen/fread del core
 ├─ rAF: frame RGBA  ◀───┐       /gaemboy/3ds/saves = IDBFS (sync 10 s)   ◀─ salvataggi, SD, NAND
 ├─ tastiera/gamepad/touch ─┤                                                 retro_run() → Azahar
 └─ AudioWorklet ◀── ring s16 ──┘  SharedArrayBuffer (COOP/COEP) = memoria WASM condivisa
```

- **Nessun upload e nessuna copia**: il file dell'utente è montato con WORKERFS e il core lo legge a blocchi
  su richiesta. Un file da 3,5 GB viene aperto in 0,7 s e la memoria del browser non cresce della sua dimensione.
- Il **frontend libretro minimo** (`azahar-web/frontend/gaemboy3ds_web.cpp`, ~300 righe) è l'API che lo studio
  chiamava *ipotetica* (§15): init, caricamento, frame, framebuffer, pulsanti, analogici e touch, audio e statistiche.
- L'emulazione gira in un **pthread** e il modulo in un **worker dedicato**. Pagina, worker e AudioWorklet
  comunicano tramite la memoria WASM condivisa (struct + ring audio), senza `postMessage` per frame.

### Patch ad Azahar (`azahar-web/patches/`)

| File | Perché |
|---|---|
| `CMakeLists.txt` | niente controllo submodule né PIC sotto Emscripten (PIC = accesso ai globali via GOT, più lento) |
| `externals/CMakeLists.txt` | `tsl::robin_map` header-only quando Dynarmic (che lo include) non viene compilato |
| `src/core/CMakeLists.txt` | `arm_tick_counts.cpp` (tabella cicli di FastInterp) anche senza Dynarmic |
| `src/common/expected.h`, `tar_file.cpp` | conversioni u64→size_t (su wasm32 `size_t` è a 32 bit) |
| `src/common/thread.cpp` | niente `pthread_setname_np` in Emscripten |
| `src/citra_libretro/CMakeLists.txt` | target eseguibile `gaemboy3ds` (core + frontend web) |
| `renderer_software.cpp` + `libretro_window.cpp` | **wide mode 800 px** dello schermo superiore (libctru `gfxSetWide`), assente in Azahar |
| `sw_rasterizer.cpp` | **dispatch a bande** in WASM: prima un job per scanline (centinaia di futex per triangolo), ora 1 job per worker |
| `libressl/arc4random.h` | hook `arc4random` per Emscripten |

Opzioni di build: `ENABLE_GENERIC` (niente Dynarmic), `ENABLE_LIBRETRO`, solo renderer software,
`-fwasm-exceptions` (Azahar usa le eccezioni C++), pthreads con pool di 8 e memoria iniziale di 1 GB.

### Risultati (Apple M2 Pro, 12 core)

| | Chromium 156 | WebKit 27.2 (Safari) |
|---|---|---|
| Caricamento `.3dsx` (23 MB) | 122 ms | 179 ms |
| Schermata titolo | **53,9 fps** (90%) | **53,1 fps** (89%) |
| Menu livelli | **41,4 fps** (69%) | **40,4 fps** (68%) |

Profilo del thread di emulazione (DevTools via CDP, `--no-liftoff`, schermata titolo):

| Fase | Prima | Dopo il dispatch a bande |
|---|---|---|
| Attesa del pool di rasterizzazione (`WaitForRequests` + `QueueWork`) | 60% | 67%, con meno lavoro totale per frame |
| Presentazione (`MemoryTransfer`, `LoadFBToScreenInfo`, blit, conversione RGBA) | ~20% | ~20% |
| CPU ARM11 (`FastInterp::ExecuteBlock`) | 3% | 3% |
| fps | 41 | **49–54** |

Controprova: con la rasterizzazione **tutta su un thread** il gioco scende a **12 fps** (titolo) e **9 fps**
(menu), con l'80% del tempo nella pipeline pixel (`ProcessTriangle`, TEV, blending). Il renderer software regge
solo grazie a ~12 thread, mentre la CPU emulata è quasi irrilevante per questo homebrew.

### Test 3D: Craftus Reloaded (senza audio)

*Craftus Reloaded* 0.3 (RSDuck, MIT; texture di XSSheep, CC BY-SA) è un clone di Minecraft in **citro3d**: mondo
3D a blocchi, texture, vertex shader PICA, 3D stereoscopico attivo (`gfxSet3D(true)`), menu touch. **Non usa
l'audio** (niente `ndsp`), quindi il test non dipende dal firmware DSP.

| Passo | Esito |
|---|---|
| Boot e menu "World select" (touch sullo schermo inferiore) | OK, ~33 fps |
| Tap su "New World" → tipo "Smea" → "Continue" (tastiera software HLE confermata in automatico) | OK |
| Generazione e rendering del mondo 3D (colline, erba, terra, cielo, braccio, mirino, inventario) | **OK, rendering corretto** |
| Avanti (X), rotazione (Circle Pad), sguardo in basso + R, cambio blocco (D-pad →) | OK (vedi `results/craftus-gameplay-chromium.png`) |
| Velocità | **~16 fps (27%)**, 61 ms per frame |

Profilo del thread di emulazione nel mondo 3D (`results/craftus-3d-profile-m2pro.json`):

| Componente | Quota del frame |
|---|---|
| Rasterizzatore software (pixel, TEV, blending) | 37% |
| Attesa dei worker di rasterizzazione | 37% |
| Sincronizzazione thread | 7% |
| Interprete shader PICA (vertex) | 6% |
| Presentazione frame | 3% |
| Comandi GPU PICA | 3% |
| **CPU ARM11 (FastInterp)** | **2%** |
| Kernel e servizi HLE | 0,2% |

Lettura: anche in 3D circa l'**80% del frame è rasterizzazione software**. Gli altri 12 worker sono occupati solo
al ~6%, perché in un mondo a blocchi i triangoli sono piccoli e il thread principale li rasterizza da solo.
Togliendo la rasterizzazione restano ~19% di 61 ms ≈ **12 ms per frame**, sotto il budget di 16,7 ms.
*Stima*: un renderer WebGL2 aggiungerebbe il suo overhead (comandi GL, upload delle texture), ma sposta
rasterizzazione e shader sulla GPU, ed è l'unica leva che può portare un gioco 3D a 60 fps.

### Problemi trovati e risolti

0. **WebGL2 lento in Chrome/macOS (14–18% → 100%).** Il collo di bottiglia era il processo GPU di Chrome
   (ANGLE su Metal), non la CPU. Gli stream buffer di Azahar (vertex 16 MiB, uniform 8 MiB) venivano aggiornati
   con `glBufferSubData` mentre la GPU li stava ancora usando. ANGLE allora copiava l'intero buffer e si
   sincronizzava (`memcpy` grandi e `waitUntilCompleted`) a ogni upload, e il worker restava in attesa sul command
   buffer. Su web i buffer ora sono più piccoli: vertex 2 MiB, index 256 KiB, uniform 256 KiB
   (`gl_rasterizer.cpp`, `#ifdef __EMSCRIPTEN__`). In più il garbage collector della `RasterizerCache`
   distruggeva e ricreava a ogni frame le surface e i framebuffer appena usati, perché
   `free tick == current frame`. Ora le surface restano vive per altri 8 frame e vengono riciclate
   (`rasterizer_cache.h`). Risultato su Craftus e Super Haxagon: 60 fps stabili, circa 1,3 ms per frame.

1. **Wide mode 800 px non supportata da Azahar.** Il sorgente di Super Haxagon disattiva il wide mode solo se il
   nome utente della console è `CITRA`/`LIME3DS`/`ENCORE`. Azahar non è in quella lista, quindi l'immagine appariva
   tagliata a metà, anche in Azahar desktop. Il wide mode è segnalato dai bit 5–6 del formato del framebuffer
   (`0x40` = 2D, `0x20` = 3D, nessuno = 800 px). L'ho implementato nel renderer software e nel blit libretro, con
   media delle colonne. È una patch che potrebbe essere proposta anche ad Azahar.
2. **Sincronizzazione per scanline nel rasterizzatore** (vedi profilo): +30% di fps con il dispatch a bande.
3. **Profilazione WASM in Chrome**: con Liftoff i frame del loop principale non vengono simbolizzati. Per
   profilare servono `--no-liftoff` e `PROFILE=1` (nomi delle funzioni).
4. **Freeze dopo ~3 s nei boot "da cartuccia"** (molte richieste FS durante il caricamento). Azahar crea un
   thread `std::async` per ogni richiesta IPC asincrona. Su web i thread vengono da un pool pre-allocato: quando
   il pool finisce, un nuovo worker può nascere solo se il thread dell'emulatore cede l'event loop, ma il loop
   resta bloccato ad aspettarlo, quindi deadlock e log fermi. Correzione: il frontend imposta
   `deterministic_async_operations = true` (le richieste girano inline sul thread dell'emulatore, senza nuovi
   thread) e il pool vale `navigator.hardwareConcurrency + 8` (rasterizer software e shader cache usano
   `hardware_concurrency` thread). La pagina ha anche un watchdog: se i frame restano fermi per più di 5 s, mostra
   un avviso. Il pulsante **Scarica log** esporta in JSON log, statistiche, user agent e numero di core.

### Provare un gioco vero (input, audio, salvataggi)

La pagina è pronta per i dump **della tua cartuccia**. Il repo non contiene giochi commerciali e non ne vengono scaricati.

| Cosa | Stato |
|---|---|
| Formati | `.3ds`/`.cci`/`.cxi`/`.app` **decrittati** (es. GodMode9 → *Decrypt*), `.zcci`/`.zcxi`, homebrew `.3dsx`/`.elf`. I `.cia` vanno installati e non si caricano direttamente. |
| File grandi | WORKERFS: nessuna copia in memoria, letture a blocchi. Verificato con un file da 3,5 GB. Self-test I/O (`?args=--io-selftest` + file con marcatori `@<offset hex>`): letture corrette **14/14** fino a 3,4 GB, sia con seek+fread sia con `pread` (`FileUtil::IOFile` di Azahar), in Chrome e WebKit. |
| ROM criptata o file non valido | Errore chiaro con il motivo del core e una spiegazione in italiano. Verificato con un'intestazione NCCH criptata sintetica. |
| Tastiera | D-pad, A/B/X/Y, L/R, **ZL/ZR**, Start/Select, **Circle Pad** (I/J/K/L), **C-Stick** (T/F/G/H). |
| Gamepad | Gamepad API, tasti per posizione come sul 3DS, stick → Circle Pad/C-Stick, grilletti → ZL/ZR. Verificato con un pad simulato. |
| Touch | Mouse, penna o dito sullo schermo inferiore. Verificato sui menu di Craftus. |
| Audio | AudioWorklet con ring condiviso e ricampionamento da 32 728 Hz. Verificato con la musica di Super Haxagon. Sotto il 100% di velocità l'audio gracchia (va in underrun). |
| Salvataggi | IndexedDB (IDBFS), sync ogni 10 s, con il pulsante "Salva ora" e alla chiusura della pagina. Verificato: il mondo Craftus sopravvive al reload. |

**Test in formato cartuccia, senza giochi commerciali.** `azahar-web/scripts/cia2cci.py` estrae dai `.cia`
ufficiali degli homebrew il programma **NCCH/CXI** (lo stesso formato del contenuto delle cartucce: ExHeader,
ExeFS con codice compresso, RomFS IVFC) e lo racchiude in un'immagine **`.3ds` NCSD** come quella di una cartuccia.
Caricati con "Carica gioco…", passano dal caricatore delle cartucce di Azahar (`ncch.cpp`, Program ID reale,
ExHeader, logo ExeFS) e si giocano:

| File | Program ID | Esito |
|---|---|---|
| `craftus_cart.3ds` (MIT) | `000400000FAB2400` | Mondo 3D creato via touch, camminata, ~16,5 fps |
| `haxagon_cart.3ds` (GPL) | `000400000099AA00` | Menu livelli col tasto A, audio attivo, ~38 fps |
| `craftus_cart.cxi` (MIT) | `000400000FAB2400` | Menu touch, ~30 fps |

Cosa resta da verificare solo con un gioco commerciale (dump della propria cartuccia): servizi HLE e
funzioni PICA usati dai giochi Nintendo (fragment lighting, shadow, procedural texture, geometry shader) e il
carico GPU reale.

Gli homebrew libctru avviano l'audio solo se esiste `sdmc:/3ds/dspfirm.cdc`. L'audio HLE di Azahar non usa quel
file, quindi il worker crea un **segnaposto vuoto** (nessun codice Nintendo). Ai giochi commerciali non serve.

Aspettative: con il renderer software un gioco 3D commerciale girerà **lento** (sotto i 16 fps visti in Craftus
su M2 Pro). Il test serve a verificare boot, menu, input e salvataggi; la velocità arriverà col renderer WebGL2.

### Limiti e prossimi passi

- **Renderer**: è il punto critico. Il prossimo POC è il **renderer OpenGL di Azahar portato su WebGL2**
  (GLES 3.0: texture buffer → texture 2D, niente geometry shader, vertex shader PICA in GLSL). Con il renderer
  hardware la GPU passa alla scheda video e il thread di emulazione si libera quasi del tutto.
- **Audio**: funziona (AudioWorklet), ma gracchia quando l'emulazione è sotto il 100%. Si risolve con la velocità
  o con un time-stretch (Azahar ha SoundTouch).
- **Giochi commerciali**: vanno forniti dall'utente come dump decrittati. Non sono inclusi né usati qui.
- Nessun materiale Nintendo nel repo: il test usa solo un homebrew GPL.

### Provarlo

```sh
azahar-web/scripts/fetch-azahar-full.sh       # Azahar @11eceda + submodule necessari + patch (~210 MB)
azahar-web/scripts/build.sh                   # Emscripten → azahar-web/dist/ (~7 min la prima volta)
mkdir -p test-homebrew && curl -L https://github.com/RedTopper/Super-Haxagon/releases/download/3.9.1/SuperHaxagon-3DS-armhf.3dsx.zip -o /tmp/h.zip && unzip -o /tmp/h.zip -d test-homebrew
curl -L -o test-homebrew/craftus_reloaded.3dsx https://github.com/RSDuck/craftus_reloaded/releases/download/0.3/craftus_reloaded.3dsx
python3 azahar-web/scripts/serve.py           # http://localhost:8766/ (header COOP/COEP inclusi)
```

Apri `http://localhost:8766/`, poi "Demo 2D" o "Demo 3D", oppure "Carica gioco…" con un tuo `.3ds`/`.cci`/`.cxi`
decrittato o un `.3dsx`. Per cambiare gioco ricarica la pagina.
Tastiera: frecce = D-pad, I/J/K/L = Circle Pad, T/F/G/H = C-Stick, X = A, Z = B, S = X, A = Y, Q/W = L/R,
E/R = ZL/ZR, Invio = Start, Backspace = Select. Il gamepad viene rilevato in automatico.
In Craftus: S avanti, I/J/K/L per guardarsi intorno, W rompe un blocco, Q lo piazza. Per profilare: `PROFILE=1 azahar-web/scripts/build.sh`.

## Correzioni allo studio di fattibilità

| Studio | Evidenza del POC |
|---|---|
| Candidato principale: **Panda3DS → WASM** | Panda3DS ha **solo Dynarmic** (`src/core/CPU/` contiene soltanto `cpu_dynarmic.cpp`), quindi in WASM non ha alcun percorso CPU. Andrebbe scritto o portato un interprete. **Azahar diventa il candidato principale**: ha un interprete veloce, già funzionante e misurato. |
| Azahar "più impegnativo da portare" | Vero per le dimensioni, ma Azahar ha già un target `ENABLE_LIBRETRO`, cioè core senza frontend con opzioni incompatibili disattivate automaticamente: il punto di partenza naturale per Emscripten. |
| "Interpreter/fallback → WASM ?" | **Risposto: sì su desktop (130–145%) e iPhone recenti (119%); no su Android di fascia media (A71: 37%).** |
| Checkpoint "BOOT → GAMEPLAY in Chrome via WASM" | **Raggiunto** (POC 2) con Azahar completo, in Chrome e Safari/WebKit. |
| "Renderer/PICA200: rischio alto" | **Confermato e quantificato**: il renderer software in WASM costa ~80–90% del tempo per frame e da solo non basta ai giochi 3D. Il renderer WebGL2 è il prossimo lavoro decisivo. |
| "Threading browser: medio/alto" | **Risolto**: pthreads + COOP/COEP funzionano in Chrome e WebKit. Il costo della sincronizzazione fine (futex) va evitato. |
| "Se gira Switch 2, gira 3DS" | Non vale per il web. Gli emulatori Switch su PC e Android eseguono il codice ARM64 del gioco **nativamente** (NCE) o tramite JIT verso codice macchina. Nel browser non si può generare codice macchina: si esegue solo WASM. Per questo nel web conta l'interprete, e questi numeri sono quelli rilevanti. |

## Raccomandazione

**Traccia A — App Android nativa (alta fattibilità).** Integrare il core di Azahar con Dynarmic ARM64 come libreria
JNI nell'app Flutter, con lo stesso schema di `nds_native` (melonDS v1.x + JIT). Azahar Android gira già su
Snapdragon 835 e successivi. Il lavoro è di integrazione (bridge, input, superfici GL/Vulkan, save), non di ricerca.
Misurato sul Galaxy A71: l'interprete FastInterp **nativo** fa già l'80% del tempo reale. Dynarmic, il JIT che Azahar
usa su Android, va molto oltre. Inoltre lo Snapdragon 730 (Cortex-A76) è più veloce in single-thread dello
Snapdragon 835 (Cortex-A73) indicato da Azahar come minimo: questa è un'inferenza, da confermare con un boot reale.
Nota licenze: Azahar è GPLv2-or-later, compatibile con la GPLv3 di melonDS che l'app già incorpora.

**Traccia B — Web desktop (fattibilità media; build e boot fatti nel POC 2).** Azahar (`ENABLE_LIBRETRO`, senza Qt,
SDL, web service o Vulkan) → Emscripten, con FastInterp e l'emulazione in un pthread. Fatto e funzionante. Rischi
aperti, in ordine:
1. **Renderer PICA200 su WebGL2 (prossimo POC).** Il renderer GL di Azahar richiede GL 4.3 / GLES 3.2, mentre WebGL2 equivale a
   GLES 3.0. Va adattato: per esempio texture buffer → texture 2D e geometry shader opzionale. Il renderer software
   è troppo lento.
2. **Vertex shader PICA**: vanno eseguiti sulla GPU (*hardware shader*), perché in WASM non c'è lo shader JIT della CPU.
3. **Thread** (pthreads, quindi COOP/COEP), **audio** (AudioWorklet), **ROM grandi** (OPFS / file handle).

Checkpoint del prossimo POC: Super Haxagon a **60 fps con renderer WebGL2**, poi un homebrew 3D (citro3d) e
infine un gioco dell'utente.

**Traccia C — Web mobile.** Gli iPhone recenti hanno un budget CPU simile al desktop, quindi possono seguire la
traccia B quando il renderer WebGL2 funziona, con un controllo sul throttling termico in sessioni lunghe.
Gli Android di fascia media (A71: 37%) nel browser non bastano. Su Android conviene indirizzare gli utenti all'app
(traccia A); per gli Android di fascia alta va fatta una misura.
Un JIT ARM→WASM sopra FastInterp, che fornirebbe già i blocchi decodificati, è R&D da valutare solo se B dà buoni
risultati.

