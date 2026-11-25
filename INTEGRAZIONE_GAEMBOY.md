# Gaemboy 3DS — Integrazione in Gaemboy (Patch 09)

Branch target: `feature/gaemboy-3ds-home-v2`.

## Comportamento predefinito

- Il sito 3DS autonomo **non mostra il titolo/logo duplicato in alto**. La scheda del browser usa il logo `home-v5-assets/logo.png` come favicon e icona Apple.
- `+ Aggiungi gioco` è **visibile** e importa ROM nella libreria; il gioco non parte automaticamente.
- I crediti appaiono in carattere piccolo **in fondo alla pagina**, anche quando la libreria contiene pochi giochi. Contengono i link alle copertine Libretro e ai sorgenti GPLv3+.
- Nessuna modifica a ROM, cache OPFS, cap 3 GB, Premium, salvataggi o core Azahar.

## Aggiungi gioco: pulsante integrato in Gaemboy

### A. Gaemboy e 3DS condividono la stessa pagina JavaScript (stesso document)

Nel `<head>`, **prima** di caricare `home-v5.js`:

```html
<script>
window.Gaemboy3DSHomeOptions = {
  addGameButton: 'external',       // Nasconde i pulsanti di importazione della home 3DS
  addGameText: '+ Aggiungi gioco', // Usato solo in modalità 'internal'
  creditsPlacement: 'bottom'      // Sempre visibili in fondo alla pagina
};
</script>
```

Dal pulsante già esistente di Gaemboy, nello **stesso evento click**:

```js
document.getElementById('il-mio-pulsante-gaemboy').addEventListener('click', () => {
  window.Gaemboy3DSHome.addGame();
});
```

`addGame()` richiama lo stesso selettore ROM interno, senza nuovi percorsi o cartelle. La chiamata deve avvenire direttamente nel click, senza `await` o timer, per rispettare l'attivazione utente richiesta dal browser. `window.Gaemboy3DSHome.getOptions()` mostra la configurazione effettiva.

### B. Gaemboy incorpora il sito 3DS in un iframe su un altro dominio

```html
<iframe id="gaemboy-3ds" src="https://domenicogonnelli.github.io/gaemboy-3ds-web/?embed=1" title="Gaemboy 3DS"></iframe>
<input id="gaemboy-rom-input" type="file" accept=".3ds,.cci,.cxi,.app,.3dsx,.elf" multiple hidden>
<button id="gaemboy-add">+ Aggiungi gioco</button>
<script>
const input = document.getElementById('gaemboy-rom-input');
const frame = document.getElementById('gaemboy-3ds');
document.getElementById('gaemboy-add').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const files = Array.from(input.files || []);
  if (files.length) frame.contentWindow.postMessage(
    {type: 'gaemboy3ds:import-rom-files', files},
    'https://domenicogonnelli.github.io'
  );
  input.value = '';
});
</script>
```

`?embed=1` nasconde i tre pulsanti di importazione 3DS (barra, stato vuoto, “Aggiungi un altro gioco”). La ROM viene importata dal file selezionato nel sito host, **senza avvio automatico**. L'iframe accetta messaggi soltanto da `gaemboy.com`, `www.gaemboy.com` e dall'origine locale esatta. I file devono essere oggetti `File`, non URL remoti; massimo 30 per messaggio. Il trasferimento di file fra domini deve essere verificato su Safari reale prima della messa in produzione.

**Importante:** non inviare soltanto il messaggio “apri il selettore file”: Safari/Chrome possono bloccare il file picker perché `postMessage` perde l'attivazione utente. Apri il picker nel click del sito host e invia i File dopo la scelta, come sopra.

## Crediti: presenza obbligatoria

**I crediti devono essere sempre visibili**, indipendentemente dall'integrazione. Non è prevista un'opzione `hideCredits`.

Comportamento predefinito: `creditsPlacement: 'bottom'` mette la dicitura completa nell'area inferiore della libreria (font 10px, non invasivo).

Se Gaemboy vuole inserirli nel proprio footer, nello **stesso documento** può configurare:

```js
window.Gaemboy3DSHomeOptions = {
  addGameButton: 'external',
  creditsPlacement: 'host',
  creditsTarget: '#gaemboy-footer-credits'
};
```

L'elemento indicato deve **esistere, essere visibile e non essere coperto dalla home 3DS quando viene costruita**. In caso contrario, il sistema lascia automaticamente i crediti **in fondo alla libreria 3DS**, anziché rimuoverli. Il sito host deve mantenerli visibili anche dopo il montaggio.

Quando il 3DS è ospitato in un iframe cross-origin, il footer non può essere spostato nel DOM del parent: la dicitura resta quindi **visibile all'interno del 3DS**. Se il sito Gaemboy vuole mostrarla nel proprio footer fuori dall'iframe, dovrà riprodurre esplicitamente i link richiesti e mantenere l'attribuzione visibile, senza affidarsi a una configurazione che la nasconda.

I credits includono i link a [Libretro Thumbnails](https://github.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS) e [sorgenti GPLv3+](https://github.com/DomenicoGonnelli/gaemboy-3ds-web). Non sostituiscono i requisiti completi della licenza: vedere `LICENSE` e `CREDITS.md`.

## Installazione

Salva o committa eventuali modifiche locali e avvia da root repository:

```sh
sh ~/Downloads/gaemboy-3ds-embed-ux-patch-09/apply-and-deploy.sh
```

Usa `--no-deploy` per applicare e verificare localmente senza push o pubblicazione. Lo script richiede la Patch 08 e il branch indicato, senza reinstallare patch precedenti.

## Test manuali raccomandati

1. Pagina diretta: favicon presente, intestazione rimossa, pulsante “+ Aggiungi gioco” presente, crediti in fondo alla viewport.
2. `?embed=1`: pulsanti di importazione della home nascosti, copertine e card invariate.
3. Integrazione Gaemboy: pulsante originale seleziona ROM, card appare, nessun avvio automatico.
4. Footer personalizzato: destinazione visibile → link spostati; destinazione inesistente → footer normale, mai nascosto.
5. Apri un gioco, torna alla home, verifica card e salvataggi; controlla Safari su ROM grandi (il trasferimento e la cache erano già oggetto di Fix07/08, non sono modificati qui).
