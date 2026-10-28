# tiket-analytics-chrome-extension

A Chrome extension that shows the analytics session data tiket.com keeps in localStorage.

## How it reads cross-origin localStorage

The analytics data does not live on the page's origin. It lives on a per-environment storage
subdomain:

| Page                  | Storage origin                |
| --------------------- | ----------------------------- |
| `gatotkaca.tiket.com` | `storage.gatotkaca.tiket.com` |
| `preprod.tiket.com`   | `storage.preprod.tiket.com`   |
| `tiket.com`           | `storage.tiket.com`           |

`localStorage` is partitioned by origin, so neither the popup nor the page can read it directly —
`iframe.contentWindow.localStorage` throws cross-origin.

tiket.com already embeds that origin as `#tiket-com-localstorage-iframe`, so the extension injects a
probe into **every frame** of the active tab. Whichever frame holds the marker reports the storage
origin (from the iframe's `src`), and whichever frame *is* that origin hands back its localStorage.

Nothing about the environment is hardcoded — the table above is discovered at runtime, so a new
environment needs no code change. The one contract this depends on is the iframe's id.

## Which keys are shown

One const at the top of `main.js` drives it:

```js
const retrievedLsKey = ["tiket-com-analytic"];
```

Add a key there and it shows up in the popup — nothing else needs touching. Each key renders as a
group, and its JSON value is flattened into one key-value row per field (nested objects become dot
paths, e.g. `utm.source`). Values that aren't JSON objects render as a single `value` row.

Note that `retrievedLsKey` must be passed to `probeFrame` through `executeScript`'s `args`. That
function is serialized and rebuilt inside the page frame, so it cannot close over anything in the
popup — referencing the const directly throws `ReferenceError` in the frame and silently yields no
data.

## Development

Install once:

```sh
npm install
```

The Tailwind stylesheet is prebuilt and committed, because Manifest V3 forbids remote scripts on
extension pages — the Tailwind CDN cannot be used here. After changing classes in `main.html` or
`main.js`, regenerate it:

```sh
npm run build:css     # one-off
npm run watch:css     # rebuild on save
```

## Loading the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder
4. Open a tiket.com / preprod / gatotkaca tab and click the extension icon

Reload the extension from `chrome://extensions` after editing `main.js` or `manifest.json`.

## Files

| File            | Role                                                   |
| --------------- | ------------------------------------------------------ |
| `manifest.json` | MV3 manifest — `scripting` + `https://*.tiket.com/*`   |
| `main.html`     | Popup markup                                           |
| `main.js`       | Frame probe, origin discovery, rendering               |
| `src/input.css` | Tailwind entry point                                   |
| `tailwind.css`  | Generated stylesheet (committed — it ships in the zip) |
