/**
 * The analytics data lives on a per-environment storage origin
 * (gatotkaca.tiket.com -> storage.gatotkaca.tiket.com, and so on), not on the page
 * origin. localStorage is partitioned by origin, so this popup cannot read it
 * directly -- and neither can the page, since `iframe.contentWindow.localStorage`
 * throws cross-origin.
 *
 * tiket.com already embeds that origin as #tiket-com-localstorage-iframe, so we
 * inject into every frame of the tab: whichever frame holds the marker tells us the
 * storage origin, and whichever frame *is* that origin hands back the data. Nothing
 * about the environment is hardcoded.
 */

/** The only list to edit when you want more localStorage keys in the popup. */
const retrievedLsKey = ["tiket-com-analytic"];

const MARKER_ID = "tiket-com-localstorage-iframe";

const els = {
  origin: document.getElementById("origin"),
  count: document.getElementById("count"),
  toolbar: document.getElementById("toolbar"),
  search: document.getElementById("search"),
  status: document.getElementById("status"),
  list: document.getElementById("list"),
  refresh: document.getElementById("refresh"),
};

/** [{ storageKey, fields: [[path, value], ...] }] for the keys in retrievedLsKey. */
let groups = [];

/**
 * Runs inside each frame of the tab. Serialized by chrome.scripting and rebuilt in
 * the frame, so it must be self-contained -- everything it needs arrives through
 * arguments, never through closure -- and return structured-cloneable values only.
 */
function probeFrame(markerId, wantedKeys) {
  const marker = document.getElementById(markerId);
  let storageOrigin = null;
  if (marker && marker.src) {
    try {
      storageOrigin = new URL(marker.src, location.href).origin;
    } catch {
      // Unparseable src: this frame just doesn't contribute an origin.
    }
  }

  // Property access itself throws in sandboxed frames or with cookies blocked, and
  // one bad frame must not fail the whole call.
  const pairs = [];
  try {
    for (const key of wantedKeys) {
      pairs.push([key, localStorage.getItem(key)]);
    }
  } catch {
    // Leave pairs empty; the frame still reports its origin.
  }

  return { origin: location.origin, storageOrigin, pairs };
}

async function read() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "No active tab." };

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: probeFrame,
      args: [MARKER_ID, retrievedLsKey],
    });
  } catch {
    // Thrown when the tab is outside our host permissions (chrome://, other sites).
    return { error: "Open a tiket.com tab to read analytics storage." };
  }

  const frames = results.map((r) => r.result).filter(Boolean);
  const storageOrigin = frames.find((f) => f.storageOrigin)?.storageOrigin;
  if (!storageOrigin) {
    return { error: `No #${MARKER_ID} on this page. Open a tiket.com tab.` };
  }

  const hit = frames.find((f) => f.origin === storageOrigin);
  if (!hit) {
    return {
      storageOrigin,
      error: "Storage frame found but not readable. Try reloading the tab.",
    };
  }

  return { storageOrigin, pairs: hit.pairs };
}

/** Render a leaf as a single line. Arrays stay compact; objects never reach here. */
function leafText(value) {
  if (value === null) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Nested objects become dot paths, so `{utm:{source:"x"}}` reads as `utm.source`. */
function flattenObject(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isPlainObject =
      value && typeof value === "object" && !Array.isArray(value);
    if (isPlainObject && Object.keys(value).length) {
      flattenObject(value, path, out);
    } else {
      out.push([path, isPlainObject ? "{}" : leafText(value)]);
    }
  }
  return out;
}

/** One stored string -> the rows it should render as. */
function toFields(raw) {
  if (raw === null) return [["", "not set"]];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [["", raw]]; // Stored as a plain string.
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const fields = flattenObject(parsed, "", []);
    return fields.length ? fields : [["", "{}"]];
  }
  return [["", leafText(parsed)]];
}

function showStatus(message) {
  els.status.textContent = message;
  els.status.classList.remove("hidden");
  els.list.classList.add("hidden");
  els.toolbar.classList.add("hidden");
}

function buildFieldRow(path, value) {
  const row = document.createElement("div");
  row.className = "group flex items-start gap-3 px-3 py-1.5 hover:bg-slate-50";

  const label = document.createElement("span");
  label.className = "w-40 shrink-0 break-all font-mono text-[11px] text-slate-500";
  label.textContent = path || "value";

  const text = document.createElement("span");
  text.className =
    "min-w-0 flex-1 break-all font-mono text-[11px] text-slate-800";
  // textContent, never innerHTML: these values come from a live page.
  text.textContent = value;

  text.addEventListener("click", async () => {
    await navigator.clipboard.writeText(value);
  });

  row.append(label, text);
  return row;
}

function buildGroup(storageKey, fields) {
  const section = document.createElement("section");
  section.className = "overflow-hidden rounded-lg border border-slate-200 bg-white";

  const heading = document.createElement("h2");
  heading.className =
    "border-b border-slate-100 bg-slate-50 px-3 py-1.5 font-mono text-[11px] font-semibold text-slate-600";
  heading.textContent = storageKey;

  const rows = document.createElement("div");
  rows.className = "divide-y divide-slate-100";
  rows.append(...fields.map(([path, value]) => buildFieldRow(path, value)));

  section.append(heading, rows);
  return section;
}

function render() {
  const term = els.search.value.trim().toLowerCase();

  // A term matching the storage key keeps that whole group, which is how you pull up
  // one key's fields without also filtering within it.
  const shown = groups
    .map(({ storageKey, fields }) => {
      if (!term || storageKey.toLowerCase().includes(term)) {
        return { storageKey, fields };
      }
      return {
        storageKey,
        fields: fields.filter(
          ([path, value]) =>
            path.toLowerCase().includes(term) ||
            value.toLowerCase().includes(term),
        ),
      };
    })
    .filter((g) => g.fields.length);

  const total = groups.reduce((n, g) => n + g.fields.length, 0);
  const visible = shown.reduce((n, g) => n + g.fields.length, 0);
  els.count.textContent =
    term && visible !== total ? `${visible} of ${total} keys` : `${total} keys`;

  els.list.replaceChildren(
    ...shown.map(({ storageKey, fields }) => buildGroup(storageKey, fields)),
  );

  if (!visible) {
    els.status.textContent = term
      ? "No keys match that filter."
      : "No analytics data in storage.";
    els.status.classList.remove("hidden");
    els.list.classList.add("hidden");
  } else {
    els.status.classList.add("hidden");
    els.list.classList.remove("hidden");
  }
}

async function load() {
  els.origin.textContent = "Reading…";
  els.count.textContent = "";
  showStatus("Reading…");

  const { storageOrigin, pairs, error } = await read();
  els.origin.textContent = storageOrigin ?? "—";

  if (error) {
    showStatus(error);
    return;
  }

  groups = pairs.map(([storageKey, raw]) => ({
    storageKey,
    fields: toFields(raw),
  }));
  els.toolbar.classList.remove("hidden");
  render();
}

els.search.addEventListener("input", render);
els.refresh.addEventListener("click", load);
load();
