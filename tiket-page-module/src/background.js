// Service worker: records every request whose URL matches the configured patterns.
//
// Two sources are merged into one entry per request:
//   - webRequest  -> full request headers (incl. cookies), status, response headers, timing
//   - page-hook   -> response body and the headers/body set by the page's JS
//
// Storage layout (chrome.storage.local):
//   settings          { patterns: string[], includeCookies: boolean }
//   tabIds            number[]  tabs that have recorded entries
//   tab:<tabId>       EntrySummary[]  (light, used for the list)
//   entry:<id>        Entry           (full, includes bodies)

const DEFAULT_SETTINGS = { patterns: ['tix-home'], includeCookies: false };
const MAX_ENTRIES_PER_TAB = 200;
const MERGE_WINDOW_MS = 30_000;
const URL_FILTER = { urls: ['*://*.tiket.com/*', 'http://localhost/*', 'http://127.0.0.1/*'] };

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ---------- settings (cached, invalidated on change) ----------

let settingsCache = null;

async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get('settings');
    settingsCache = { ...DEFAULT_SETTINGS, ...settings };
  }
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) settingsCache = null;
});

async function isTracked(url) {
  const { patterns } = await getSettings();
  const lower = url.toLowerCase();
  return patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

// ---------- serialised storage writes ----------

let writeQueue = Promise.resolve();

function serial(task) {
  const run = writeQueue.then(task);
  writeQueue = run.catch((error) => console.error('[page-module-inspector]', error));
  return run;
}

const tabKey = (tabId) => `tab:${tabId}`;
const entryKey = (id) => `entry:${id}`;

async function readList(tabId) {
  const key = tabKey(tabId);
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  return list;
}

function summarize(entry) {
  return {
    id: entry.id,
    tabId: entry.tabId,
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    pageUrl: entry.pageUrl,
    status: entry.status,
    statusText: entry.statusText,
    error: entry.error,
    startedAt: entry.startedAt,
    duration: entry.duration,
    size: entry.responseBody?.length ?? null,
    hasBody: entry.responseBody != null,
    fromNetwork: Boolean(entry.requestId),
    fromPage: Boolean(entry.transport),
    fromCache: entry.fromCache,
  };
}

function withoutUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// Must run inside serial(). `list` is the current tab list; it is updated and written back.
async function writeEntry(id, tabId, list, patchFn) {
  const key = entryKey(id);
  const { [key]: existing } = await chrome.storage.local.get(key);
  const base = existing ?? { id, tabId, createdAt: Date.now() };
  const entry = { ...base, ...withoutUndefined(patchFn(base)) };
  if (entry.startedAt && entry.endedAt) entry.duration = Math.max(0, Math.round(entry.endedAt - entry.startedAt));

  const summary = summarize(entry);
  const index = list.findIndex((item) => item.id === id);
  let removed = [];
  if (index >= 0) {
    list[index] = summary;
  } else {
    list.push(summary);
    if (list.length > MAX_ENTRIES_PER_TAB) removed = list.splice(0, list.length - MAX_ENTRIES_PER_TAB);
  }

  const updates = { [key]: entry, [tabKey(tabId)]: list };
  if (!existing) {
    const { tabIds = [] } = await chrome.storage.local.get('tabIds');
    if (!tabIds.includes(tabId)) updates.tabIds = [...tabIds, tabId];
  }
  await chrome.storage.local.set(updates);
  if (removed.length) await chrome.storage.local.remove(removed.map((item) => entryKey(item.id)));
  await updateBadge(tabId, list.length);
}

async function updateBadge(tabId, count) {
  if (tabId < 0) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0064D2' });
    await chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 999)) : '' });
  } catch {
    // tab closed in the meantime
  }
}

const isNear = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) < MERGE_WINDOW_MS;

// ---------- webRequest (headers, status, timing) ----------

function decodeRequestBody(requestBody) {
  if (!requestBody) return undefined;
  if (requestBody.formData) {
    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(requestBody.formData)) {
      for (const value of values) params.append(name, value);
    }
    return params.toString();
  }
  if (requestBody.raw?.length) {
    const decoder = new TextDecoder();
    return requestBody.raw.map((part) => (part.bytes ? decoder.decode(part.bytes) : `[file ${part.file}]`)).join('');
  }
  return undefined;
}

async function resolvePageUrl(details) {
  if (details.tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(details.tabId);
      if (tab.url) return tab.url;
    } catch {
      // tab gone
    }
  }
  return details.initiator;
}

async function recordNetwork(details, patchFn) {
  if (!(await isTracked(details.url))) return;
  const pageUrl = details.type === 'main_frame' ? details.url : await resolvePageUrl(details);
  await serial(async () => {
    const list = await readList(details.tabId);
    let target = list.find((item) => item.requestId === details.requestId);
    // The page hook may have reported first (e.g. a cached response): attach to that entry.
    target ??= list.find(
      (item) =>
        !item.fromNetwork &&
        item.method === details.method &&
        item.url === details.url &&
        isNear(item.startedAt, details.timeStamp),
    );
    const id = target?.id ?? `n${details.requestId}-${Date.now().toString(36)}`;
    await writeEntry(id, details.tabId, list, (entry) => ({
      requestId: details.requestId,
      url: entry.url ?? details.url,
      method: details.method,
      resourceType: details.type,
      frameId: details.frameId,
      pageUrl: entry.pageUrl ?? pageUrl,
      ...patchFn(entry),
    }));
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void recordNetwork(details, (entry) => ({
      startedAt: entry.startedAt ?? Math.round(details.timeStamp),
      requestBody: entry.requestBody ?? decodeRequestBody(details.requestBody),
    }));
  },
  URL_FILTER,
  ['requestBody'],
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    void recordNetwork(details, () => ({ requestHeaders: details.requestHeaders }));
  },
  URL_FILTER,
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    void recordNetwork(details, () => ({
      status: details.statusCode,
      statusText: details.statusLine?.replace(/^HTTP\/\S+\s+\d+\s*/, '') || undefined,
      responseHeaders: details.responseHeaders,
      fromCache: details.fromCache,
      ip: details.ip,
      endedAt: Math.round(details.timeStamp),
    }));
  },
  URL_FILTER,
  ['responseHeaders', 'extraHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    void recordNetwork(details, () => ({ error: details.error, endedAt: Math.round(details.timeStamp) }));
  },
  URL_FILTER,
);

// ---------- page hook (response body) ----------

async function recordPageCapture(capture, tabId, frameId) {
  await serial(async () => {
    const list = await readList(tabId);
    const target = list.find(
      (item) =>
        item.fromNetwork &&
        !item.fromPage &&
        item.method === capture.method &&
        item.url === capture.url &&
        isNear(item.startedAt, capture.startedAt),
    );
    const id = target?.id ?? `p${crypto.randomUUID()}`;
    await writeEntry(id, tabId, list, (entry) => ({
      url: entry.url ?? capture.url,
      method: entry.method ?? capture.method,
      frameId: entry.frameId ?? frameId,
      transport: capture.transport,
      pageUrl: capture.pageUrl,
      jsRequestHeaders: capture.requestHeaders,
      jsResponseHeaders: capture.responseHeaders,
      requestBody: entry.requestBody ?? capture.requestBody ?? undefined,
      responseBody: capture.responseBody,
      responseBodyTruncated: capture.responseBodyTruncated,
      status: entry.status ?? capture.status,
      statusText: entry.statusText ?? capture.statusText,
      error: entry.error ?? capture.error,
      startedAt: entry.startedAt ?? capture.startedAt,
      endedAt: entry.endedAt ?? capture.endedAt,
    }));
  });
}

// ---------- clearing ----------

async function clearTab(tabId) {
  const list = await readList(tabId);
  await chrome.storage.local.remove([tabKey(tabId), ...list.map((item) => entryKey(item.id))]);
  const { tabIds = [] } = await chrome.storage.local.get('tabIds');
  await chrome.storage.local.set({ tabIds: tabIds.filter((id) => id !== tabId) });
  await updateBadge(tabId, 0);
}

async function clearAll() {
  const { tabIds = [] } = await chrome.storage.local.get('tabIds');
  for (const tabId of tabIds) await clearTab(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'page-capture' && sender.tab) {
    recordPageCapture(message.payload, sender.tab.id, sender.frameId).catch(console.error);
    return false;
  }
  if (message?.type === 'clear') {
    (async () => {
      try {
        await serial(() => (message.tabId == null ? clearAll() : clearTab(message.tabId)));
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    })();
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(() => clearTab(tabId));
});

// Tab ids are not stable across browser restarts, so start fresh.
chrome.runtime.onStartup.addListener(() => {
  void serial(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.clear();
    if (settings) await chrome.storage.local.set({ settings });
  });
});
