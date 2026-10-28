// Runs in the page's MAIN world at document_start.
// Wraps fetch and XMLHttpRequest so the response body of tracked requests can be read
// (webRequest only sees headers). Captures are handed to bridge.js via a DOM event.
(() => {
  const TAG = '__tiketPageModuleInspector';
  if (window[TAG]) return;
  Object.defineProperty(window, TAG, { value: true });

  const MAX_BODY_CHARS = 10 * 1024 * 1024;
  let patterns = ['tix-home'];

  window.addEventListener(`${TAG}:config`, (event) => {
    try {
      const config = JSON.parse(event.detail);
      if (Array.isArray(config.patterns)) patterns = config.patterns;
    } catch {
      // ignore malformed config
    }
  });
  // Ask the bridge for the saved patterns in case it loaded before us.
  window.dispatchEvent(new CustomEvent(`${TAG}:ready`));

  const isTracked = (url) => {
    const lower = String(url).toLowerCase();
    return patterns.some((p) => p && lower.includes(String(p).toLowerCase()));
  };

  const absoluteUrl = (url) => {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return String(url);
    }
  };

  const headerList = (headers) => {
    const list = [];
    try {
      new Headers(headers ?? undefined).forEach((value, name) => list.push({ name, value }));
    } catch {
      // headers we cannot read are simply omitted
    }
    return list;
  };

  const parseRawHeaders = (raw) =>
    String(raw ?? '')
      .trim()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(':');
        return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
      });

  const bodyToString = async (body) => {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      return [...body]
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : `[file ${value.name}]`}`)
        .join('&');
    }
    if (body instanceof Blob) return body.text();
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return `[unreadable body: ${Object.prototype.toString.call(body)}]`;
  };

  const emit = (capture) => {
    if (typeof capture.responseBody === 'string' && capture.responseBody.length > MAX_BODY_CHARS) {
      capture.responseBody = capture.responseBody.slice(0, MAX_BODY_CHARS);
      capture.responseBodyTruncated = true;
    }
    window.dispatchEvent(
      new CustomEvent(`${TAG}:capture`, {
        detail: JSON.stringify({ ...capture, pageUrl: location.href }),
      }),
    );
  };

  // ---- fetch ----
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function fetch(input, init) {
      let url;
      let method;
      try {
        url = absoluteUrl(input instanceof Request ? input.url : String(input));
        method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      } catch {
        return nativeFetch.apply(this, arguments);
      }
      if (!isTracked(url)) return nativeFetch.apply(this, arguments);

      const startedAt = Date.now();
      const requestHeaders = headerList(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // Clone a Request body before fetch consumes it.
      const requestBodyPromise =
        init?.body !== undefined
          ? bodyToString(init.body)
          : input instanceof Request && method !== 'GET' && method !== 'HEAD'
            ? input.clone().text()
            : Promise.resolve(null);

      const responsePromise = nativeFetch.apply(this, arguments);

      void (async () => {
        let response;
        try {
          response = await responsePromise;
        } catch (error) {
          emit({
            transport: 'fetch',
            url,
            method,
            requestHeaders,
            requestBody: await requestBodyPromise.catch(() => null),
            error: String(error?.message ?? error),
            startedAt,
            endedAt: Date.now(),
          });
          return;
        }
        // Clone right away, before the page's own handlers consume the body.
        let copy = null;
        let cloneError;
        try {
          copy = response.clone();
        } catch (error) {
          cloneError = error;
        }
        const requestBody = await requestBodyPromise.catch(() => null);
        let responseBody;
        try {
          responseBody = copy ? await copy.text() : `[could not read body: ${cloneError?.message ?? cloneError}]`;
        } catch (error) {
          responseBody = `[could not read body: ${error?.message ?? error}]`;
        }
        emit({
          transport: 'fetch',
          url,
          method,
          requestHeaders,
          requestBody,
          status: response.status,
          statusText: response.statusText,
          responseHeaders: headerList(response.headers),
          responseBody,
          startedAt,
          endedAt: Date.now(),
        });
      })();

      return responsePromise;
    };
  }

  // ---- XMLHttpRequest ----
  const xhrProto = XMLHttpRequest.prototype;
  const xhrInfo = new WeakMap();
  const nativeOpen = xhrProto.open;
  const nativeSetRequestHeader = xhrProto.setRequestHeader;
  const nativeSend = xhrProto.send;

  xhrProto.open = function open(method, url) {
    xhrInfo.set(this, { method: String(method).toUpperCase(), url: absoluteUrl(url), requestHeaders: [] });
    return nativeOpen.apply(this, arguments);
  };

  xhrProto.setRequestHeader = function setRequestHeader(name, value) {
    xhrInfo.get(this)?.requestHeaders.push({ name: String(name).toLowerCase(), value: String(value) });
    return nativeSetRequestHeader.apply(this, arguments);
  };

  xhrProto.send = function send(body) {
    const info = xhrInfo.get(this);
    if (info && isTracked(info.url)) {
      const startedAt = Date.now();
      const requestBodyPromise = bodyToString(body ?? null);
      this.addEventListener('loadend', () => {
        void (async () => {
          let responseBody = null;
          try {
            if (this.responseType === '' || this.responseType === 'text') responseBody = this.responseText;
            else if (this.responseType === 'json') responseBody = this.response == null ? null : JSON.stringify(this.response);
            else responseBody = `[${this.responseType} response not captured]`;
          } catch {
            // body unavailable
          }
          emit({
            transport: 'xhr',
            url: info.url,
            method: info.method,
            requestHeaders: info.requestHeaders,
            requestBody: await requestBodyPromise.catch(() => null),
            status: this.status,
            statusText: this.statusText,
            responseHeaders: parseRawHeaders(this.getAllResponseHeaders()),
            responseBody,
            error: this.status === 0 ? 'Network error or request aborted' : undefined,
            startedAt,
            endedAt: Date.now(),
          });
        })();
      });
    }
    return nativeSend.apply(this, arguments);
  };
})();
