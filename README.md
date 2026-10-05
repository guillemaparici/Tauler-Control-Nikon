# NikonLink Web

Control remot de càmeres **Nikon per USB directament des del navegador** (WebUSB). Sense instal·lar cap programa ni servidor: s'obre un enllaç, es connecta la càmera per USB i es controla des de l'ordinador, la tauleta o el mòbil.

> **Estat: Fase A (prototip de connexió).** Connexió, ISO / diafragma / velocitat / balanç de blancs, Live View, AF/MF i disparar. Bulk Capture (fase B) i Sky Stack (fase C) encara no hi són.
> **Important:** s'ha provat només amb una càmera USB *simulada*. Encara no s'ha verificat amb una Nikon real (objectiu: D3300). Si alguna cosa falla, mira l'apartat [Si no connecta](#si-no-connecta).

**Enllaç:** `https://EL-TEU-USUARI.github.io/NOM-DEL-REPOSITORI/` (vegeu [Publicar](#publicar-a-github-pages))
**Demo sense càmera:** afegeix `?demo` a l'enllaç.

## Què cal per fer-lo servir

| Dispositiu | Funciona? | Què necessita |
|---|---|---|
| Ordinador amb **Chrome, Edge o Opera** | Sí | Cable USB. A **Windows** cal un pas previ (driver, vegeu avall). |
| **Android** (mòbil o tauleta) amb **Chrome** | Sí | Cable **USB OTG**. No cal cap driver. |
| **iPhone / iPad** | **No** | Apple no permet USB des del navegador. |
| Firefox / Safari | **No** | No suporten WebUSB. |

## Com s'usa

1. Càmera en mode **M** (manual). Per a astrofotografia, objectiu en **MF**.
2. Connecta la càmera per **USB** al dispositiu i encén-la.
3. Obre l'enllaç, prem **Conectar cámara** i tria la Nikon a la llista del navegador.
4. Activa **Live View**, canvia ISO / diafragma / velocitat arrossegant els dials, dispara amb el botó rodó (o amb la barra espaciadora).

La foto es guarda a **la targeta de la càmera** (la descàrrega al dispositiu arriba a la fase B).

## Preparació per sistema operatiu

### Windows (un sol cop)
Windows s'apropia de la càmera amb el seu driver MTP, i el navegador no la pot obrir. Cal assignar-li el driver **WinUSB**:
1. Connecta i encén la càmera. Tanca altres programes que la facin servir.
2. Descarrega **Zadig** (zadig.akeo.ie) → *Options → List All Devices*.
3. Tria la càmera Nikon (USB ID `04B0`) → driver **WinUSB** → *Replace Driver*.

Mentre tingui WinUSB, la càmera no apareix com a unitat a l'Explorador. Per desfer-ho: Administrador de dispositius → la càmera → *Desinstal·lar el dispositiu* (marca eliminar el controlador) i reconnecta-la.

### Android
Cable OTG, Chrome, i accepta el permís USB quan el demani. Si falla, tanca apps de galeria/fotos que puguin tenir la càmera oberta i reconnecta el cable.

### Linux
Cal una regla udev. Crea `/etc/udev/rules.d/50-nikon.rules` amb:
```
SUBSYSTEM=="usb", ATTR{idVendor}=="04b0", MODE="0666"
```
i executa `sudo udevadm control --reload-rules`; reconnecta la càmera. Assegura't que cap programa (gvfs, gphoto2) la té oberta.

### macOS
Normalment funciona. Si el navegador no pot reclamar la càmera, tanca *Fotos* i *Captura d'imatge*; hi pot haver un procés del sistema que l'ocupi.

## Si no connecta

1. Obre la pestanya **Diagnóstico** i prem **Copiar informe** (o *Descargar .txt*).
2. Enganxa'l tal qual: inclou el model, les operacions PTP que la càmera declara i el resultat de cada pas de la connexió. Amb això es pot corregir el que falli amb la teva càmera concreta.

Missatges habituals:
- *No se pudo abrir / reclamar la cámara* → falta el driver WinUSB (Windows) o la regla udev (Linux), o un altre programa la té oberta.
- *Gira el dial a M* → la càmera no és en manual; sense això no deixa canviar velocitat ni diafragma.
- *La cámara rechazó el disparo* → sense enfocament (posa'l en MF o enfoca), targeta plena o sense targeta.
- La càmera es va adormir → l'app ho detecta i intenta reconnectar sola; si no, desperta la càmera i prem *Conectar*.

## Publicar a GitHub Pages

1. Crea un repositori **públic** nou (per exemple `nikonlink`).
2. Puja **el contingut** d'aquesta carpeta a l'arrel del repositori (que `index.html` quedi a l'arrel, no dins d'una subcarpeta): *Add file → Upload files*, arrossega els fitxers i carpetes, *Commit*.
3. *Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save*.
4. Al cap d'1–2 minuts l'enllaç és `https://EL-TEU-USUARI.github.io/NOM-DEL-REPOSITORI/`. GitHub Pages serveix HTTPS, que WebUSB exigeix.

## Desenvolupament

```bash
node test/ptp.test.mjs        # 15 proves amb una Nikon USB simulada (Node 18+)
python3 -m http.server 8000   # i obre http://localhost:8000/?demo
```
`localhost` compta com a context segur, així que WebUSB funciona també en local.

```
index.html        interfície
style.css         estils (mode vermell per a visió nocturna inclòs)
js/ptp.js         transport PTP sobre WebUSB
js/nikon.js       càmera Nikon: propietats, Live View, disparo, AF/MF, diagnòstic
js/sim.js         càmera simulada (?demo)
js/app.js         interfície i controls
test/             càmera USB simulada i proves
```

## Pla

- **Fase A** (aquesta): connexió, Live View, controls bàsics i disparar.
- **Fase B:** Bulk Capture (intervalòmetre, Holy Grail) i descàrrega de fotos al dispositiu.
- **Fase C:** Sky Stack al navegador (alineat d'estrelles, sigma-clip, Ground Lock).

Limitacions conegudes de WebUSB: la pestanya ha de quedar oberta i la pantalla encesa durant les seqüències llargues, i el Live View per USB va a la velocitat que doni la càmera (a la D3300, probablement 10–20 fps i poca resolució).
