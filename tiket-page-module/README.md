# tiket Page Module Inspector

Chrome extension (Manifest V3) that records every request whose URL contains `page-module`
on tiket.com, e.g.

```
https://www.tiket.com/ms-gateway/tix-home/v2/page-modules-full?pageModuleCode=hotel_LP&variant=hotel_LP
```

and shows the result in a side panel, with one-click **Copy cURL** for the backend team.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension, open a tiket.com page, and click the icon. The side panel opens.
4. Reload the page so the recorder is active from the first request.

## What it does

- **Records** every request whose URL contains any of your patterns (default `page-module`,
  so `page-modules-full`, `page-module/...` etc. are all caught). Change patterns in **Settings**.
- **Badge** on the toolbar icon shows how many calls were recorded in the current tab.
- **List** per tab (or all tabs): method, status, endpoint, query params (`pageModuleCode`,
  `variant`, …), the page it was called from, duration and size. Filter by URL.
- **Overview**: page URL, status, timing, query params, trace/request-ID headers, response
  `code`/`message`, and a table of the modules in the response (click a row to copy its path).
- **Response**: collapsible JSON tree or raw view, search by key/value, click a key to copy its
  path (e.g. `data[3].code`). Copy or download the JSON.
- **Headers**: full request headers (including cookies and auth headers set by the app) and
  response headers.
- **Copy cURL**: bash cURL with the exact headers the browser sent. Cookies are left out by
  default; turn on **Include cookies** in Settings if the endpoint needs the session cookie.
- **Copy for backend**: Markdown report (page URL, request, status, timing, query params, trace
  IDs, response summary, browser, cURL, and a body excerpt on errors) ready to paste in Slack/Jira.
- **Replay**: sends the same request again from the page so it uses the page's session.
- **Fetch**: call any URL from inside the current tab (pre-filled with the hotel_LP URL), reusing
  the headers of the latest captured call. Handy when the page rendered its modules server-side.

## How it works

| Piece | Role |
| --- | --- |
| `src/page-hook.js` | Runs in the page (MAIN world) at `document_start`, wraps `fetch`/`XMLHttpRequest` to read response bodies of matching URLs. |
| `src/bridge.js` | Content script that relays captures to the service worker and pushes the URL patterns to the hook. |
| `src/background.js` | Uses `webRequest` for the real request headers (incl. cookies), status and timing; merges them with the hook's body into one entry in `chrome.storage.local`. |
| `sidepanel/` | The UI. `lib/curl.js` builds the cURL and backend report, `lib/json-view.js` is the lazy JSON tree. |

Recorded data stays in the browser (`chrome.storage.local`), is removed when a tab closes, and is
wiped on browser restart. Up to 200 requests are kept per tab.

## Limits

- Calls made **server-side** (Next.js SSR / `getServerSideProps`) never reach the browser, so they
  cannot be recorded. Use **Fetch** to call the API from the page instead.
- Requests made by a service worker are listed under "All tabs" without a response body.
- New patterns apply to the hook after the page is reloaded.
