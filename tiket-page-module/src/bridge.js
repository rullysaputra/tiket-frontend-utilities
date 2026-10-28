// Runs in the ISOLATED world. Relays captures from page-hook.js to the service worker
// and pushes the saved URL patterns down to the hook.
const TAG = '__tiketPageModuleInspector';
const DEFAULT_PATTERNS = ['tix-home'];

function pushConfig(settings) {
  window.dispatchEvent(
    new CustomEvent(`${TAG}:config`, {
      detail: JSON.stringify({ patterns: settings?.patterns ?? DEFAULT_PATTERNS }),
    }),
  );
}

async function loadAndPushConfig() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    pushConfig(settings);
  } catch {
    // extension was reloaded; this content script is orphaned
  }
}

window.addEventListener(`${TAG}:capture`, async (event) => {
  let payload;
  try {
    payload = JSON.parse(event.detail);
  } catch {
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: 'page-capture', payload });
  } catch {
    // extension was reloaded or the service worker is unavailable
  }
});

window.addEventListener(`${TAG}:ready`, () => void loadAndPushConfig());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) pushConfig(changes.settings.newValue);
});

void loadAndPushConfig();
