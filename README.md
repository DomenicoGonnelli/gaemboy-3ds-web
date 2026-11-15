# GAEMBOY 3DS LAB — POC 1: CPU ARM11 in WebAssembly

**Data:** 15 novembre 2026 · **Base:** Azahar `11eceda` (master 12/11/2026) · **Macchina:** Apple M2 Pro

Questo POC affronta il **rischio n.1** dello studio di fattibilità (*"CPU/JIT → WASM: molto alto"*).
Domanda: un interprete ARM11 compilato in WebAssembly regge il tempo reale di un 3DS?

## TL;DR

| | Risultato |
|---|---|
| L'interprete ARM11 compila e gira in WASM? | **Sì**: gli interpreti reali di Azahar (DynCom e FastInterp) compilano con Emscripten **senza modificarne il codice**. Tutti i checksum corrispondono al riferimento nativo. |
| Velocità in browser (desktop M2 Pro) | **FastInterp: 130% del tempo reale 3DS in Chrome, 145% in Safari** (mix di carichi, CPU emulata al 100% di carico). |
| Costo del passaggio a WASM | Si conserva il **67–75% della velocità nativa**. |
| DynCom (interprete classico Citra) | 65–66%: **insufficiente** (soprattutto in virgola mobile: 40%). |
| Verdetto CPU | **GO condizionato per desktop**: la CPU tiene il tempo reale con ~30–45% di margine, ma il margine va condiviso con GPU, audio e HLE. Su mobile web servirà quasi certamente un JIT ARM→WASM. |
| App Android nativa | **Strada più sicura**: Azahar con JIT Dynarmic su ARM64, stessa architettura già usata per melonDS nativo. |

## Cosa è stato misurato

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

## Risultati

%RT (MIPS). FI = FastInterp, DC = DynCom. JSON completi in [`cpu-bench/results/`](cpu-bench/results).

| Workload | Nativo FI | Chrome FI | Safari FI | Nativo DC | Chrome DC | Safari DC |
|---|---|---|---|---|---|---|
| entities (game logic) | 172% (388) | 110% (248) | 113% (254) | 92% (207) | 57% (128) | 68% (154) |
| crc32 (table lookups) | 181% (431) | 117% (278) | 127% (304) | 96% (229) | 76% (181) | 81% (192) |
| shellsort | 235% (341) | 183% (266) | 194% (281) | 117% (169) | 98% (142) | 105% (153) |
| vertex xform (VFP) | 469% (659) | 294% (413) | 335% (471) | 51% (72) | 40% (57) | 44% (61) |
| bytecode VM (script) | 204% (312) | 155% (236) | 159% (243) | 92% (140) | 75% (115) | 75% (114) |
| block copy (ldm/stm) | 251% (614) | 153% (373) | 175% (428) | 91% (222) | 71% (174) | 79% (194) |
| crc32 [thumb] | 187% (500) | 117% (314) | 135% (362) | 92% (246) | 75% (201) | 71% (191) |
| bytecode VM [thumb] | 156% (418) | 99% (266) | 119% (318) | 66% (178) | 55% (146) | 53% (142) |
| **mix** | **194% (409)** | **130% (274)** | **145% (307)** | 80% (169) | 66% (140) | 65% (137) |

Nativo = Apple clang `-O3` arm64. Chrome 157 / Chromium 156 headless, WebKit 27.2 (motore di Safari) via Playwright.
Node 22 (V8 meno recente) dà 107% sul mix, vedi `wasm-node.json`.

## Lettura dei risultati

1. **Il "muro" CPU/JIT non è un muro.** Non serve inventare un percorso CPU: Azahar ha già FastInterp,
   un interprete a blocchi pre-decodificati con fusione di istruzioni, e lo usa automaticamente quando Dynarmic non
   è disponibile (`core.cpp`: `HAVE_FASTINTERP` + `use_fastinterp`). Compila in WASM così com'è, perché il
   computed goto viene abbassato a `br_table`.
2. **Il margine su desktop è reale ma non enorme.** 130–145% significa che, con la CPU emulata al 100%, restano
   ~25–30% del tempo per tutto il resto (PICA200, servizi HLE, DSP), oppure si possono usare altri thread.
   I giochi pesanti (Pokémon X/Y, Sole/Luna) caricano molto l'ARM11: su un desktop veloce sono **plausibili ma al
   limite**. I giochi 2D o leggeri hanno più margine.
3. **Mobile web**: le CPU dei telefoni hanno prestazioni single-thread inferiori a un M2 Pro, e il rapporto
   WASM/nativo resta simile. *Stima, da verificare*: i top di gamma recenti potrebbero restare sotto o vicino al
   100%, la fascia media molto sotto. Per il 3DS su mobile web serve probabilmente un **JIT ARM→WASM**
   (blocchi ARM tradotti in moduli WebAssembly a runtime, come fanno v86 o Play! per PS2). È un lavoro di R&D di
   mesi, non un passo del POC. **Misuralo direttamente**: vedi "Prova sul telefono".
4. **Memoria**: FastInterp usa ~11 MB di block cache (16384 blocchi × 664 B) più 4 MB di page table vuota.
   DynCom invece riserva staticamente 125 MiB di cache di traduzione: un'altra ragione per escluderlo in WASM.

## Correzioni allo studio di fattibilità

| Studio | Evidenza del POC |
|---|---|
| Candidato principale: **Panda3DS → WASM** | Panda3DS ha **solo Dynarmic** (`src/core/CPU/` contiene soltanto `cpu_dynarmic.cpp`), quindi in WASM non ha alcun percorso CPU. Andrebbe scritto o portato un interprete. **Azahar diventa il candidato principale**: ha un interprete veloce, già funzionante e misurato. |
| Azahar "più impegnativo da portare" | Vero per le dimensioni, ma Azahar ha già un target `ENABLE_LIBRETRO`, cioè core senza frontend con opzioni incompatibili disattivate automaticamente: il punto di partenza naturale per Emscripten. |
| "Interpreter/fallback → WASM ?" | **Risposto: sì**, con il 130–145% del tempo reale su desktop. |
| "Se gira Switch 2, gira 3DS" | Non vale per il web. Gli emulatori Switch su PC e Android eseguono il codice ARM64 del gioco **nativamente** (NCE) o tramite JIT verso codice macchina. Nel browser non si può generare codice macchina: si esegue solo WASM. Per questo nel web conta l'interprete, e questi numeri sono quelli rilevanti. |

## Raccomandazione

**Traccia A — App Android nativa (alta fattibilità).** Integrare il core di Azahar con Dynarmic ARM64 come libreria
JNI nell'app Flutter, con lo stesso schema di `nds_native` (melonDS v1.x + JIT). Azahar Android gira già su
Snapdragon 835 e successivi. Il lavoro è di integrazione (bridge, input, superfici GL/Vulkan, save), non di ricerca.
Nota licenze: Azahar è GPLv2-or-later, compatibile con la GPLv3 di melonDS che l'app già incorpora.

**Traccia B — Web desktop (fattibilità media, prossimo POC).** Azahar (`ENABLE_LIBRETRO`-like, senza Qt, SDL, web
service o Vulkan) → Emscripten, con FastInterp e un Web Worker per l'emulazione. Rischi aperti, in ordine:
1. **Renderer PICA200 su WebGL2.** Il renderer GL di Azahar richiede GL 4.3 / GLES 3.2, mentre WebGL2 equivale a
   GLES 3.0. Va adattato: per esempio texture buffer → texture 2D e geometry shader opzionale. Il renderer software
   è troppo lento.
2. **Vertex shader PICA**: vanno eseguiti sulla GPU (*hardware shader*), perché in WASM non c'è lo shader JIT della CPU.
3. **Thread** (pthreads, quindi COOP/COEP), **audio** (AudioWorklet), **ROM grandi** (OPFS / file handle).

Checkpoint del prossimo POC: *boot di un homebrew 3DS libero (es. demo libctru) in Chrome*, con frame time
diviso tra CPU, GPU e HLE.

**Traccia C — Web mobile (lungo termine).** JIT ARM→WASM sopra FastInterp, che fornirebbe già i blocchi decodificati.
Da valutare solo se B dà buoni risultati.

## Prova sul telefono

La cartella `cpu-bench/build/web/` è statica e autosufficiente: non servono SharedArrayBuffer né HTTPS.

```sh
cd cpu-bench/build/web && python3 -m http.server 8765 --bind 0.0.0.0
# dal telefono (stessa Wi-Fi): http://<IP-del-Mac>:8765/  -> "Avvia benchmark" -> "Copia risultati"
```

Il verdetto in fondo alla pagina si basa sul mix FastInterp: ≥150% buono, 100–150% al limite, <100% insufficiente.

## Riprodurre

Servono `~/emsdk` (già presente), clang con backend ARM (Apple clang va bene) e Playwright per i browser.

```sh
./scripts/fetch-azahar.sh                      # sparse checkout ~4 MB, commit fissato
cd cpu-bench
./scripts/build-guest.sh                       # binario ARMv6K + checksum di riferimento
./scripts/build-host.sh native && ./build/native/cpu_bench build/guest/bench.bin build/guest/expected.txt
./scripts/build-host.sh node   && node build/node/cpu_bench.js build/guest/bench.bin build/guest/expected.txt
./scripts/build-host.sh web                    # -> build/web/ (pagina + worker + wasm)
(cd build/web && python3 -m http.server 8765) &
PLAYWRIGHT=/path/to/node_modules/playwright node scripts/run-browsers.mjs http://127.0.0.1:8765/
```

## Limiti del test

- Il benchmark è **sintetico**: niente MMIO, cambi di thread o eccezioni. I giochi veri passano più spesso dai
  percorsi lenti (I/O, SVC) e invalidano la cache. In un gioco ci si aspetta una velocità CPU un po' inferiore.
- Si misura solo la CPU. GPU, audio e servizi HLE restano da misurare nel POC 2.
- %RT al 100% presuppone un ARM11 sempre occupato (caso peggiore). Il carico reale di un gioco è inferiore.
- Non è incluso nessun materiale Nintendo (ROM, firmware, chiavi): il guest è codice nostro.
