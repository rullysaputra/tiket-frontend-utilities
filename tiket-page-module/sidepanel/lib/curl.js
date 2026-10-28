// Builders for the text people copy out of the inspector: a bash cURL and a
// Markdown report with enough context for the backend team.

const SKIPPED_HEADERS = new Set(['content-length', 'host', 'connection']);
const TRACE_HEADER = /(request[-_]?id|trace|correlation|span[-_]?id|x-amzn|cf-ray)/i;
const FORBIDDEN_FETCH_HEADER = /^(cookie|cookie2|host|origin|referer|user-agent|accept-encoding|accept-charset|connection|content-length|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Network headers are what Chrome actually sent; page headers fill gaps
// (e.g. when the request was only seen by the page hook).
export function requestHeadersOf(entry) {
  const byName = new Map();
  for (const header of entry.jsRequestHeaders ?? []) byName.set(header.name.toLowerCase(), header);
  for (const header of entry.requestHeaders ?? []) byName.set(header.name.toLowerCase(), header);
  return [...byName.values()].filter((header) => !header.name.startsWith(':'));
}

export function responseHeadersOf(entry) {
  return entry.responseHeaders?.length ? entry.responseHeaders : (entry.jsResponseHeaders ?? []);
}

export function buildCurl(entry, { includeCookies = false } = {}) {
  const method = (entry.method ?? 'GET').toUpperCase();
  const body = entry.requestBody;
  const hasBody = body != null && body !== '';
  const parts = [`curl ${shellQuote(entry.url)}`];

  if (method !== 'GET' && !(method === 'POST' && hasBody)) parts.push(`-X ${method}`);

  let compressed = false;
  for (const { name, value } of requestHeadersOf(entry)) {
    const lower = name.toLowerCase();
    if (SKIPPED_HEADERS.has(lower)) continue;
    if (lower === 'cookie') {
      if (includeCookies) parts.push(`-b ${shellQuote(value)}`);
      continue;
    }
    if (lower === 'accept-encoding') compressed = true;
    parts.push(`-H ${shellQuote(`${name}: ${value}`)}`);
  }

  if (hasBody) parts.push(`--data-raw ${shellQuote(body)}`);
  if (compressed) parts.push('--compressed');
  return parts.join(' \\\n  ');
}

// Headers that can be replayed from page JavaScript (the browser adds the rest).
export function replayableHeaders(entry) {
  const source = entry.jsRequestHeaders?.length ? entry.jsRequestHeaders : requestHeadersOf(entry);
  return Object.fromEntries(
    source
      .filter(({ name }) => !name.startsWith(':') && !FORBIDDEN_FETCH_HEADER.test(name))
      .map(({ name, value }) => [name, value]),
  );
}

export function traceHeaders(entry) {
  const found = [];
  for (const header of [...responseHeadersOf(entry), ...requestHeadersOf(entry)]) {
    if (TRACE_HEADER.test(header.name) && !found.some((item) => item.name.toLowerCase() === header.name.toLowerCase())) {
      found.push(header);
    }
  }
  return found;
}

export function parseJson(text) {
  if (typeof text !== 'string' || text === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function formatBytes(chars) {
  if (chars == null) return '—';
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDateTime(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const offset = -date.getTimezoneOffset() / 60;
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${local} (UTC${offset >= 0 ? '+' : ''}${offset})`;
}

export function buildBackendReport(entry, options = {}) {
  const url = new URL(entry.url);
  const params = [...url.searchParams].map(([key, value]) => `\`${key}=${value}\``).join(', ');
  const json = parseJson(entry.responseBody);
  const status = entry.error ? `failed: ${entry.error}` : `${entry.status ?? '?'} ${entry.statusText ?? ''}`.trim();

  const lines = [
    `### Page module API — ${url.searchParams.get('pageModuleCode') ?? url.pathname.split('/').pop()}`,
    '',
    `- **Page URL:** ${entry.pageUrl ?? '—'}`,
    `- **Request:** \`${entry.method} ${entry.url}\``,
    `- **Status:** ${status} · ${entry.duration != null ? `${entry.duration} ms` : '—'} · ${formatBytes(entry.responseBody?.length)}`,
    `- **Captured at:** ${formatDateTime(entry.startedAt)}`,
  ];
  if (params) lines.push(`- **Query params:** ${params}`);

  const traces = traceHeaders(entry);
  if (traces.length) lines.push(`- **Trace / request IDs:** ${traces.map((h) => `\`${h.name}: ${h.value}\``).join(', ')}`);

  if (json.ok && json.value && typeof json.value === 'object' && !Array.isArray(json.value)) {
    const { code, message, errors, serverTime } = json.value;
    const fields = Object.entries({ code, message, errors, serverTime })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    if (fields.length) lines.push(`- **Response summary:** ${fields.join(' · ')}`);
  }
  lines.push(`- **Browser:** ${navigator.userAgent}`);

  lines.push('', '**cURL**', '```bash', buildCurl(entry, options), '```');

  const failed = entry.error || (entry.status ?? 0) >= 400;
  if (failed && entry.responseBody) {
    const excerpt = entry.responseBody.length > 1500 ? `${entry.responseBody.slice(0, 1500)}…` : entry.responseBody;
    lines.push('', '**Response body (excerpt)**', '```json', excerpt, '```');
  }
  return lines.join('\n');
}
