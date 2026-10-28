import {
  buildBackendReport,
  buildCurl,
  formatBytes,
  formatDateTime,
  parseJson,
  replayableHeaders,
  requestHeadersOf,
  responseHeadersOf,
  traceHeaders,
} from './lib/curl.js';
import { childPath, renderJsonTree, searchJson } from './lib/json-view.js';

const DEFAULT_SETTINGS = { patterns: ['page-module'], includeCookies: false };
const DEFAULT_FETCH_URL =
  'https://www.tiket.com/ms-gateway/tix-home/v2/page-modules-full?pageModuleCode=hotel_LP&variant=hotel_LP';
const MODULE_LABEL_FIELDS = ['code', 'moduleCode', 'name', 'title', 'type', 'moduleType', 'template', 'templateCode', 'variant', 'id'];

const $ = (id) => document.getElementById(id);

const state = {
  windowId: null,
  tabId: null,
  tabUrl: '',
  scope: 'tab',
  filter: '',
  settings: { ...DEFAULT_SETTINGS },
  list: [],
  selectedId: null,
  entry: null,
  detailTab: 'overview',
  responseMode: 'tree',
  renderedResponseFor: null,
};

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message, kind = 'info') {
  const node = $('toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2400);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(message);
}

function statusClass(item) {
  if (item.error) return 'err';
  if (item.status == null) return 'pending';
  if (item.status >= 500 || item.status === 0) return 'err';
  if (item.status >= 400) return 'warn';
  if (item.status >= 300) return 'redirect';
  return 'ok';
}

function statusText(item) {
  if (item.error) return 'ERR';
  return item.status == null ? '…' : String(item.status);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString([], { hour12: false }) : '';
}

function prettyBody(entry) {
  const json = parseJson(entry.responseBody);
  return json.ok ? JSON.stringify(json.value, null, 2) : (entry.responseBody ?? '');
}

// ---------- tab tracking ----------

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  state.tabId = tab?.id ?? null;
  state.tabUrl = tab?.url ?? '';
  renderTabLabel();
  await loadList();
}

function renderTabLabel() {
  const url = safeUrl(state.tabUrl);
  $('tab-label').textContent = url ? `${url.host}${url.pathname}` : 'No page';
  $('tab-label').title = state.tabUrl;
}

// ---------- list ----------

async function loadList() {
  if (state.scope === 'all') {
    const { tabIds = [] } = await chrome.storage.local.get('tabIds');
    const lists = tabIds.length ? await chrome.storage.local.get(tabIds.map((id) => `tab:${id}`)) : {};
    state.list = Object.values(lists)
      .flat()
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  } else if (state.tabId != null) {
    const key = `tab:${state.tabId}`;
    const { [key]: list = [] } = await chrome.storage.local.get(key);
    state.list = list;
  } else {
    state.list = [];
  }
  renderList();
}

let listReloadTimer;
function scheduleListReload() {
  clearTimeout(listReloadTimer);
  listReloadTimer = setTimeout(() => void loadList(), 120);
}

function renderList() {
  const needle = state.filter.trim().toLowerCase();
  const items = state.list
    .filter((item) => !needle || item.url.toLowerCase().includes(needle) || (item.pageUrl ?? '').toLowerCase().includes(needle))
    .reverse();

  $('entries').replaceChildren(...items.map(renderRow));
  $('empty').hidden = items.length > 0;
  $('count-label').textContent = state.list.length
    ? `${items.length} of ${state.list.length} request${state.list.length === 1 ? '' : 's'} · newest first`
    : '';
}

function renderRow(item) {
  const url = safeUrl(item.url);
  const li = el('li');
  const button = el('button', 'entry');
  button.type = 'button';
  button.addEventListener('click', () => void openDetail(item.id));

  const line1 = el('div', 'entry-line');
  line1.append(
    el('span', 'badge method', item.method),
    el('span', `badge status ${statusClass(item)}`, statusText(item)),
    el('span', 'entry-path truncate', url ? url.pathname.split('/').filter(Boolean).slice(-2).join('/') : item.url),
    el('span', 'entry-time muted', formatTime(item.startedAt)),
  );
  button.append(line1);

  if (url && [...url.searchParams].length) {
    const chips = el('div', 'chips');
    for (const [key, value] of [...url.searchParams].slice(0, 4)) chips.append(el('span', 'chip', `${key}=${value}`));
    button.append(chips);
  }

  const meta = [];
  const page = safeUrl(item.pageUrl);
  if (page) meta.push(page.pathname === '/' ? page.host : page.pathname);
  if (item.duration != null) meta.push(`${item.duration} ms`);
  if (item.size != null) meta.push(formatBytes(item.size));
  if (!item.hasBody && item.status != null) meta.push('no body');
  if (item.fromCache) meta.push('cache');
  if (state.scope === 'all') meta.push(item.tabId < 0 ? 'service worker' : `tab ${item.tabId}`);
  button.append(el('div', 'entry-meta muted truncate', meta.join(' · ')));

  li.append(button);
  return li;
}

// ---------- detail ----------

async function openDetail(id) {
  const key = `entry:${id}`;
  const { [key]: entry } = await chrome.storage.local.get(key);
  if (!entry) {
    toast('This request is no longer stored', 'error');
    return;
  }
  state.selectedId = id;
  state.entry = entry;
  state.renderedResponseFor = null;
  $('list-view').hidden = true;
  $('detail-view').hidden = false;
  renderDetail();
  window.scrollTo(0, 0);
}

function closeDetail() {
  state.selectedId = null;
  state.entry = null;
  $('detail-view').hidden = true;
  $('list-view').hidden = false;
}

function renderDetail() {
  const entry = state.entry;
  if (!entry) return closeDetail();

  const badges = $('detail-badges');
  badges.replaceChildren(
    el('span', 'badge method', entry.method),
    el('span', `badge status ${statusClass(entry)}`, entry.error ? 'ERR' : `${entry.status ?? '…'} ${entry.statusText ?? ''}`.trim()),
  );
  if (entry.duration != null) badges.append(el('span', 'muted', `${entry.duration} ms`));
  $('detail-url').textContent = entry.url;

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === state.detailTab;
    tab.setAttribute('aria-selected', String(active));
    $(`tab-${tab.dataset.tab}`).hidden = !active;
  }

  renderOverview(entry);
  renderHeaders(entry);
  renderCurlTab(entry);
  // Rebuilding the tree would collapse what the user expanded, so only do it when the body changes.
  const bodyKey = `${entry.id}:${entry.responseBody?.length ?? 'none'}:${state.responseMode}`;
  if (state.renderedResponseFor !== bodyKey) {
    renderResponse(entry);
    state.renderedResponseFor = bodyKey;
  }
}

function definitionList(rows) {
  const dl = el('dl', 'kv');
  for (const [label, value] of rows) {
    if (value == null || value === '') continue;
    dl.append(el('dt', null, label));
    const dd = el('dd');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = String(value);
    dl.append(dd);
  }
  return dl;
}

function section(title, ...children) {
  const wrap = el('section', 'block');
  wrap.append(el('h2', null, title), ...children);
  return wrap;
}

function headerTable(headers) {
  if (!headers.length) return el('p', 'muted', 'None captured.');
  const table = el('table', 'table');
  const body = el('tbody');
  for (const { name, value } of headers) {
    const row = el('tr');
    row.append(el('th', null, name), el('td', null, value));
    body.append(row);
  }
  table.append(body);
  return table;
}

function captureSource(entry) {
  if (entry.requestId && entry.transport) return `Network + page (${entry.transport})`;
  if (entry.requestId) return 'Network only — response body not seen by the page hook';
  return `Page only (${entry.transport})`;
}

function findModuleList(json) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json)) return { path: '', items: json };
  if (Array.isArray(json.data)) return { path: 'data', items: json.data };
  for (const [parentPath, container] of [['data', json.data], ['', json]]) {
    if (!container || typeof container !== 'object') continue;
    for (const [key, value] of Object.entries(container)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') {
        return { path: childPath(parentPath, key), items: value };
      }
    }
  }
  return null;
}

function moduleTable(found) {
  const fields = MODULE_LABEL_FIELDS.filter((field) =>
    found.items.some((item) => item && typeof item === 'object' && item[field] != null && typeof item[field] !== 'object'),
  ).slice(0, 3);
  const table = el('table', 'table modules');
  const head = el('tr');
  head.append(el('th', null, '#'), ...fields.map((field) => el('th', null, field)));
  if (!fields.length) head.append(el('th', null, 'keys'));
  const body = el('tbody');
  found.items.forEach((item, index) => {
    const row = el('tr', 'clickable');
    const path = childPath(found.path, index);
    row.title = `Click to copy path ${path}`;
    row.addEventListener('click', () => void copyText(path, `Copied path ${path}`));
    row.append(el('td', 'muted', String(index)));
    if (fields.length) {
      for (const field of fields) row.append(el('td', null, item?.[field] == null ? '' : String(item[field])));
    } else {
      row.append(el('td', null, item && typeof item === 'object' ? Object.keys(item).slice(0, 5).join(', ') : String(item)));
    }
    body.append(row);
  });
  const thead = el('thead');
  thead.append(head);
  table.append(thead, body);
  return table;
}

function renderOverview(entry) {
  const panel = $('tab-overview');
  const page = el('a', 'link', entry.pageUrl ?? '—');
  if (entry.pageUrl) {
    page.href = entry.pageUrl;
    page.target = '_blank';
    page.rel = 'noreferrer';
  }

  const blocks = [
    section(
      'Request',
      definitionList([
        ['Page URL', page],
        ['Status', entry.error ? `Failed: ${entry.error}` : `${entry.status ?? 'pending'} ${entry.statusText ?? ''}`],
        ['Started', formatDateTime(entry.startedAt)],
        ['Duration', entry.duration != null ? `${entry.duration} ms` : null],
        ['Size', entry.responseBody != null ? formatBytes(entry.responseBody.length) : null],
        ['Captured by', captureSource(entry)],
        ['Remote IP', entry.ip],
        ['From cache', entry.fromCache ? 'yes' : null],
      ]),
    ),
  ];

  const url = safeUrl(entry.url);
  if (url && [...url.searchParams].length) {
    blocks.push(section('Query params', headerTable([...url.searchParams].map(([name, value]) => ({ name, value })))));
  }

  const traces = traceHeaders(entry);
  if (traces.length) blocks.push(section('Trace / request IDs', headerTable(traces)));

  const json = parseJson(entry.responseBody);
  if (json.ok && json.value && typeof json.value === 'object' && !Array.isArray(json.value)) {
    const { code, message, errors, serverTime } = json.value;
    const rows = Object.entries({ code, message, errors, serverTime })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : value]);
    if (rows.length) blocks.push(section('Response summary', definitionList(rows)));
  }

  const modules = json.ok ? findModuleList(json.value) : null;
  if (modules) blocks.push(section(`Modules · ${modules.path || 'root'} (${modules.items.length})`, moduleTable(modules)));

  if (entry.requestBody) blocks.push(section('Request body', el('pre', 'code', entry.requestBody)));

  if (entry.responseBody == null && entry.status != null) {
    blocks.push(
      el(
        'p',
        'notice',
        'The response body was not captured (the request did not go through the page’s fetch/XHR, e.g. a service worker or a request made before the page loaded). Use Replay to fetch it again from the page.',
      ),
    );
  }
  panel.replaceChildren(...blocks);
}

function renderHeaders(entry) {
  const cookieNote = state.settings.includeCookies ? null : el('p', 'hint', 'Cookie header is shown here but left out of copied cURLs (see Settings).');
  $('tab-headers').replaceChildren(
    section('Request headers', headerTable(requestHeadersOf(entry)), ...(cookieNote ? [cookieNote] : [])),
    section('Response headers', headerTable(responseHeadersOf(entry))),
  );
}

function renderCurlTab(entry) {
  const curl = buildCurl(entry, { includeCookies: state.settings.includeCookies });
  const note = el(
    'p',
    'hint',
    state.settings.includeCookies ? 'Cookies included.' : 'Cookies excluded — enable them in Settings if the API needs the session cookie.',
  );
  $('tab-curl').replaceChildren(el('pre', 'code', curl), note);
}

function renderResponse(entry) {
  const panel = $('tab-response');
  if (entry.responseBody == null) {
    panel.replaceChildren(el('p', 'notice', 'No response body captured for this request. Try Replay.'));
    return;
  }
  const truncatedNotice = () => el('p', 'notice', 'Body was larger than 10 MB and has been truncated.');

  const json = parseJson(entry.responseBody);
  if (!json.ok) {
    panel.replaceChildren(el('pre', 'code', entry.responseBody));
    if (entry.responseBodyTruncated) panel.prepend(truncatedNotice());
    return;
  }

  const toolbar = el('div', 'toolbar');
  const modes = el('div', 'segmented');
  for (const mode of ['tree', 'raw']) {
    const button = el('button', 'seg', mode === 'tree' ? 'Tree' : 'Raw');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.responseMode === mode));
    button.addEventListener('click', () => {
      state.responseMode = mode;
      renderDetail();
    });
    modes.append(button);
  }
  const search = el('input', 'grow');
  search.type = 'search';
  search.placeholder = 'Find key or value…';
  search.spellcheck = false;
  toolbar.append(modes, search);

  const results = el('div', 'search-results');
  results.hidden = true;
  const content = el('div', 'response-body');

  const onCopyPath = (path) => void copyText(path || '(root)', `Copied path ${path || '(root)'}`);
  if (state.responseMode === 'tree') content.append(renderJsonTree(json.value, { expandDepth: 2, onKeyClick: onCopyPath }));
  else content.append(el('pre', 'code', JSON.stringify(json.value, null, 2)));

  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = search.value;
      if (!query.trim()) {
        results.hidden = true;
        return;
      }
      const hits = searchJson(json.value, query);
      results.hidden = false;
      results.replaceChildren(el('p', 'muted', hits.length >= 200 ? 'First 200 matches · click to copy path' : `${hits.length} match${hits.length === 1 ? '' : 'es'} · click to copy path`));
      for (const hit of hits) {
        const row = el('button', 'hit');
        row.type = 'button';
        row.append(el('span', 'hit-path', hit.path || '(root)'), el('span', 'hit-value truncate', hit.value));
        row.addEventListener('click', () => onCopyPath(hit.path));
        results.append(row);
      }
    }, 150);
  });

  panel.replaceChildren(toolbar, results, content);
}

// ---------- page actions ----------

async function fetchInPage(tabId, { url, method, headers, body }) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [url, method, headers, body ?? null],
    func: async (requestUrl, requestMethod, requestHeaders, requestBody) => {
      try {
        const response = await fetch(requestUrl, {
          method: requestMethod,
          headers: requestHeaders,
          body: requestBody ?? undefined,
          credentials: 'include',
        });
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    },
  });
  return injection?.result ?? { ok: false, error: 'No result from page' };
}

function matchesPatterns(url) {
  const lower = url.toLowerCase();
  return state.settings.patterns.some((p) => p && lower.includes(p.toLowerCase()));
}

async function runInPage(tabId, request, label) {
  if (tabId == null) {
    toast('No tab to run the request in', 'error');
    return false;
  }
  try {
    const result = await fetchInPage(tabId, request);
    if (result.ok) toast(`${label}: HTTP ${result.status}`);
    else toast(`${label} failed: ${result.error}`, 'error');
    return result.ok;
  } catch (error) {
    toast(`Cannot run in this tab — open a tiket.com page first (${error.message})`, 'error');
    return false;
  }
}

async function replay() {
  const entry = state.entry;
  if (!entry) return;
  let tabId = entry.tabId >= 0 ? entry.tabId : state.tabId;
  try {
    await chrome.tabs.get(tabId);
  } catch {
    tabId = state.tabId;
  }
  const body = entry.method === 'GET' || entry.method === 'HEAD' ? null : entry.requestBody;
  const ok = await runInPage(tabId, { url: entry.url, method: entry.method, headers: replayableHeaders(entry), body }, 'Replayed');
  // The replay is recorded as a new entry; go back to the list so it is visible.
  if (ok) closeDetail();
}

async function manualFetch() {
  const url = $('fetch-url').value.trim();
  if (!safeUrl(url)) {
    toast('Enter a valid URL', 'error');
    return;
  }
  let headers = {};
  if ($('fetch-reuse-headers').checked) {
    const latest = [...state.list].reverse().find((item) => item.fromNetwork || item.fromPage);
    if (latest) {
      const key = `entry:${latest.id}`;
      const { [key]: entry } = await chrome.storage.local.get(key);
      if (entry) headers = replayableHeaders(entry);
    }
  }
  const ok = await runInPage(state.tabId, { url, method: 'GET', headers, body: null }, 'Fetched');
  if (ok && !matchesPatterns(url)) toast('Fetched, but the URL does not match your patterns so it was not recorded', 'error');
}

function downloadResponse() {
  const entry = state.entry;
  if (!entry?.responseBody) {
    toast('No response body to download', 'error');
    return;
  }
  const url = safeUrl(entry.url);
  const name = url?.searchParams.get('pageModuleCode') ?? url?.pathname.split('/').pop() ?? 'response';
  const stamp = new Date(entry.startedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const blobUrl = URL.createObjectURL(new Blob([prettyBody(entry)], { type: 'application/json' }));
  const link = el('a');
  link.href = blobUrl;
  link.download = `${name}-${stamp}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// ---------- settings ----------

function renderSettings() {
  $('patterns-input').value = state.settings.patterns.join(', ');
  $('include-cookies').checked = state.settings.includeCookies;
}

async function saveSettings() {
  const patterns = $('patterns-input')
    .value.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const settings = {
    patterns: patterns.length ? patterns : DEFAULT_SETTINGS.patterns,
    includeCookies: $('include-cookies').checked,
  };
  await chrome.storage.local.set({ settings });
  state.settings = settings;
  renderSettings();
  if (state.entry) renderDetail();
  toast('Settings saved — reload the page so the hook picks up new patterns');
}

function toggleDrawer(drawerId, buttonId) {
  const drawer = $(drawerId);
  drawer.hidden = !drawer.hidden;
  $(buttonId).setAttribute('aria-expanded', String(!drawer.hidden));
}

// ---------- wiring ----------

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (changes.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings();
  }
  if (Object.keys(changes).some((key) => key.startsWith('tab:') || key === 'tabIds')) scheduleListReload();
  const selected = state.selectedId && changes[`entry:${state.selectedId}`];
  if (selected) {
    if (!selected.newValue) {
      closeDetail();
    } else {
      state.entry = selected.newValue;
      renderDetail();
    }
  }
}

function bindEvents() {
  $('filter-input').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderList();
  });
  $('scope-select').addEventListener('change', (event) => {
    state.scope = event.target.value;
    void loadList();
  });
  $('clear-btn').addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'clear', tabId: state.scope === 'all' ? null : state.tabId });
    if (response?.ok) toast('Cleared');
    else toast(`Clear failed: ${response?.error ?? 'unknown error'}`, 'error');
  });
  $('toggle-settings').addEventListener('click', () => toggleDrawer('settings-panel', 'toggle-settings'));
  $('toggle-fetch').addEventListener('click', () => toggleDrawer('fetch-panel', 'toggle-fetch'));
  $('save-settings').addEventListener('click', () => void saveSettings());
  $('run-fetch').addEventListener('click', () => void manualFetch());
  $('fetch-url').value = DEFAULT_FETCH_URL;

  $('back-btn').addEventListener('click', closeDetail);
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.detailTab = tab.dataset.tab;
      renderDetail();
    });
  }
  $('copy-curl').addEventListener('click', () => {
    if (!state.entry) return;
    const { includeCookies } = state.settings;
    void copyText(buildCurl(state.entry, { includeCookies }), `cURL copied${includeCookies ? ' (with cookies)' : ''}`);
  });
  $('copy-report').addEventListener('click', () => {
    if (!state.entry) return;
    void copyText(buildBackendReport(state.entry, { includeCookies: state.settings.includeCookies }), 'Backend report copied (Markdown)');
  });
  $('copy-response').addEventListener('click', () => {
    if (!state.entry?.responseBody) return toast('No response body captured', 'error');
    void copyText(prettyBody(state.entry), 'Response copied');
  });
  $('download-response').addEventListener('click', downloadResponse);
  $('replay-btn').addEventListener('click', () => void replay());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('detail-view').hidden) closeDetail();
  });
}

async function init() {
  const currentWindow = await chrome.windows.getCurrent();
  state.windowId = currentWindow.id;
  const { settings } = await chrome.storage.local.get('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  renderSettings();
  bindEvents();

  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.windowId) void refreshActiveTab();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.tabId && changeInfo.url) {
      state.tabUrl = changeInfo.url;
      renderTabLabel();
    }
  });
  chrome.storage.onChanged.addListener(onStorageChanged);

  await refreshActiveTab();
}

init().catch((error) => toast(`Failed to start: ${error.message}`, 'error'));
