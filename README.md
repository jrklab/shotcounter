# Web Basketball Score Display

A zero-install basketball scoreboard that runs in your browser over Web Bluetooth.

**Live app** → [https://jrklab.github.io/basket_counting/](https://jrklab.github.io/basket_counting/)

## How it works

| Layer | Technology |
|---|---|
| UI | Plain HTML + CSS |
| Logic | Vanilla ES-module JavaScript |
| BLE | [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) |
| Hosting | GitHub Pages (free, static) |

No build tools, no npm, no server — the three `.js` files are loaded directly by the browser.

## Browser support

| Browser | Platform | Works? |
|---|---|---|
| Chrome 85+ | Android | ✅ |
| Edge 85+ | Android | ✅ |
| Chrome / Edge | Windows / Linux / macOS | ✅ |
| Safari | iOS / macOS | ❌ Apple blocks Web Bluetooth |
| Firefox | all | ❌ not implemented |

## Files

```
src/web/
├── index.html      Main page — UI, layout, event wiring
├── ble.js          Web Bluetooth connect / notify layer
├── parser.js       Binary packet parser (mirrors data_receiver.py)
└── classifier.js   Shot classifier + baseline calibrator (mirrors shot_classifier.py)
```

## Setting up GitHub Pages

1. Push the repo to GitHub.
2. Go to **Settings → Pages**.
3. Under *Source*, select **Deploy from a branch**.
4. Branch: `main` (or your default branch), folder: **`/src/web`**.
5. Click **Save**.

GitHub will publish the app at:
```
https://<your-username>.github.io/<repo-name>/
```

Replace the link at the top of this file with your actual URL, then share it — anyone with a supported browser can open it without installing anything.

## Usage

1. Power on the ESP32.
2. Open the URL on an Android phone (Chrome or Edge).
3. Tap **Connect** → select **ESP32-Basketball** from the BLE picker.
4. Wait ~3 seconds for baseline calibration (progress bar shown).
5. Shoot! The score updates in real time with audio feedback.
6. Tap **Clear Score** to reset; baseline recalibrates automatically.
