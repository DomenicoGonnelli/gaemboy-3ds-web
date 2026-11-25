# Gaemboy 3DS - Gameplay UX 11

## Modalita desktop e mobile

- **Desktop (mouse + schermo ampio):** la skin Gaemboy include gli schermi 3DS e i medesimi controlli interattivi gia usati dal core (Circle Pad, C-Stick, tasti azione, spalle, Start/Select). Tastiera e gamepad rimangono attivi. Il canvas e lo stesso (`#screen`): nessun cambiamento al formato video o alla mappatura touch.
- **Mobile/tablet touch o viewport fino a 840px:** nessuna skin, con due schermi e comandi touch responsive. In orizzontale gli schermi sono a sinistra e i comandi a destra, in verticale sono impilati.
- **Menu:** colori coordinati con la libreria Gaemboy. Funzioni e callback esistenti invariati.

## Integrazione in Gaemboy.com

Prima di caricare lo script `gaemboy3ds-game.js`, si puo impostare:

```js
window.Gaemboy3DSGameOptions = {
  desktopSkin: 'gaemboy',        // 'gaemboy' oppure 'none'
  mobileSkin: false,            // la skin e sempre esclusa sui dispositivi touch/mobile
  showDesktopControls: true,    // false: lascia solo tastiera/gamepad su desktop
  palette: 'rose'               // 'rose', 'violet' oppure 'midnight'
};
```

Viene usato il medesimo `#screen` e il medesimo `#touch-controls` per le due modalita. Il file `gaemboy3ds-game.js` non interagisce con ROM, cache, salvataggi o worker. L'oggetto `Gaemboy3DSGameUI.refresh()` riapplica il tema dopo variazioni delle opzioni.

Palette base: burgundy `#27061D`, rosa Gaemboy `#E01961`, rosa chiaro `#F18CAF`, pannello `#390C2D`. Si tratta di una proposta coerente con la libreria v5, non della copia di una skin NDS privata: per replicare un asset o file CSS specifico presente nell'app Gaemboy servira il relativo codice o lo screenshot della schermata di gioco NDS.

## Funzioni mantenute

Nessuna modifica a `gaemboy3ds-page.js`, `gaemboy3ds-worker.js` o `gaemboy3ds-touch.js`. Restano i tasti `data-button`, le levette, l'interazione touch nel canvas, il menu impostazioni/salvataggi/cheat e l'avvio dalla cache.

## Verifiche e limiti

Eseguire test con un gioco reale su Safari e Chrome, in desktop, iPhone verticale/orizzontale e tablet: dimensioni schermo, coordinate touch del pannello inferiore, tutti i pulsanti, menu e gamepad. I test Node verificano le configurazioni e la struttura, ma non equivalgono a test gameplay reali.

## Deploy

Estrarre lo ZIP e, nel repository sul branch `feature/gaemboy-3ds-home-v2`, eseguire `sh <cartella-estratta>/apply-and-deploy.sh`. Verificare che al termine il marker `document.querySelector('meta[name="gaemboy-build"]')?.content` sia `game-ux11`. Non cancellare i dati del sito o gli IndexedDB.
