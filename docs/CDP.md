# CDP collector

Node.js 24 provides the WebSocket/fetch clients. The collector uses raw Chrome DevTools Protocol. It does not depend on an extension, Selenium, or Playwright.

When the app opens a test browser, it creates and activates a known top-level page using the browser connection. It navigates that exact target and main frame, rather than the first discovered page (which may be an Edge onboarding/sign-in dialog). Headful test windows request a maximized normal browser window; manually attached tabs are left under the user's control. `node scripts/browser-start-smoke.mjs` verifies that an existing startup page remains unchanged while the website loads in a different top-level page.

- Browser launch always uses a separate profile in `.profiles/`, a localhost debug address, and an explicit debug port. The normal user browser is never terminated. An existing debug port must be attached explicitly instead of silently reused by the launcher.
- Edge `RemoteDebuggingAllowed=0` in HKLM/HKCU policy is reported as an error; the tool does not bypass it.
- `Runtime.addBinding` and `Page.addScriptToEvaluateOnNewDocument` capture `dataLayer`/`InsiderQueue`. Existing default frame contexts are also instrumented. New same-renderer and out-of-process iframe contexts are handled. A 750 ms discovery poll attaches matching new tabs.
- Existing queue contents are historical evidence and do not belong to a newly started test step. Late/replacement arrays are hooked synchronously when their property permits it, with polling for vendor replacement of `push`. A shared depth guard prevents duplicate evidence when a vendor wraps an earlier collector wrapper.
- `push` arguments, its receiver and its return value are preserved. Payloads are snapshotted without mutation. Stop removes injection registrations/bindings and restores properties where ownership can still be established.
- `stop({timeoutMs:3000})` disables capture immediately and performs frame cleanup in parallel under a single deadline capped at three seconds. It then disconnects even if frames, commands, or a callback never finish. `forceStop()` synchronously cancels discovery/startup and disconnects; generation guards prevent older connections from emitting into a restarted session. A deadline may leave unreachable page-side wrappers until navigation, while the disconnected collector no longer records their calls.
- `closeOwnedBrowser(handle,{timeoutMs:1500})` is separate from collector detach. It accepts only the original handle returned by this process's launcher, checks that its child is alive, and compares the browser WebSocket identity before `Browser.close`. Attached browsers, copied handles and reused debug ports are never followed. Endpoint/command shutdown shares one deadline; this helper does not terminate processes.
- Network captures configured hostname/path patterns only. CORS OPTIONS preflight is excluded from event counts. Request payloads use `request.postData` or `Network.getRequestPostData`, then the shared decoder. Request, response, and failure records have separate `network.phase` values and keep the original request timestamp. Only request phase counts as an event.
- HTTP success proves a network response, not vendor ingestion. First-party or unfamiliar vendors require explicit endpoint patterns and a supported decoder/rules. Opaque fields must remain unparsed evidence rather than inferred business events.

Limitations: very early events in a newly opened tab before the next discovery poll can only be recovered from its queue backlog; start the test step after that tab is attached. Worker-only requests and already-finished requests before attach may not be available. Nonconfigurable/frozen custom queues cannot be safely wrapped. Existing vendor accessors retain their own semantics and use the polling fallback.

## Verification

`node --test tests/cdp-injection.test.mjs tests/cdp-connection.test.mjs tests/cdp-browser-close.test.mjs` runs isolated queue, launcher and mock-CDP tests. It includes nested vendor wrappers, late/replacement queues, stop/restart, missing request body retrieval, interleaved CDP responses, lifecycle separation, bounded cleanup of stalled frames/callbacks, startup cancellation, and owned-browser identity checks.

Optional real-browser read-only Trip.com smoke in PowerShell:

```powershell
$env:EVENTQA_LIVE_CDP = '1'
node --test tests/cdp-live.test.mjs
Remove-Item Env:EVENTQA_LIVE_CDP
```

It uses a dedicated headless Chrome profile and saves observations under `runs/live-trip-cdp/`. It navigates to the homepage only, makes no synthetic analytics calls and does not claim tracking PASS/FAIL without a Trip specification. Its additional Trip telemetry hostname was observed in browser network requests. The live test is skipped by the normal test suite. A managed execution sandbox may block browser WebSocket frames even when `/json/list` works; the interactive product itself does not require a sandbox exemption.

Protocol reference: https://chromedevtools.github.io/devtools-protocol/ (Runtime, Page, Network, Target domains).
