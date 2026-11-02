# Internal module contract

Node.js 24 ESM. Main code uses plain JSON objects. Three separately runnable modes share a deterministic core. No Playwright, Selenium or extensions.

## Event

`{schema_version:'1.0', evidence_id, session_id, test_case_id, step_id, captured_at:ISO, source:'GA4'|'INSIDER'|'CUSTOM', layer:'JS_QUEUE'|'TRACKING_REQUEST', event_name, queue_name?, page:{url,title?,frame_id?}, payload:{...}, network?:{request_id,url,method,status?,error?,phase?}, correlation:{action_at?,delta_ms?}, privacy:{redacted:true}}`

Collectors emit partial Event without evidence_id/session/correlation. Root `SessionManager.emit` normalizes, redacts and stores. Network lifecycle updates MUST emit separate records with `network.phase='response'|'failed'`; only `phase='request'` counts as an event. `captured_at` is request/event time, not response time. Backlog queue records should set `historical:true` and are stored without current step association.

## Case and rule

Case: `{id,name,source,flow,description?,provenance?:{file,sheet,row},needs_review?:boolean,rules:[Rule]}`.

Rule: `{id?,event_name,source?,layer:'JS_QUEUE'|'TRACKING_REQUEST',count:{min:1,max:1},within_ms?:3000,after?:'event_name',fields:{'path':{op:'eq'|'exists'|'not_exists'|'type'|'regex'|'one_of'|'range'|'ref'|'subset'|'ignore',value?:any,optional?:boolean}},needs_review?:boolean}`. Ref is e.g. `context.search.term`. Direct dotted property takes precedence over path traversal. Array indices supported.

Step: `{id,test_case_id,started_at,completed_at?,context:{search:{term:'snack'}},status:'RUNNING'|'COMPLETED'|'NOT_EXECUTED',evidence_id:'STEP-...'}`. Findings for missing events reference step evidence_id. Never conflate missing context/review with FAIL.

## Public module exports (assigned ownership)

Core agent: `src/core/rules.mjs`: `validateCase(testCase, events, step)` => `{test_case_id,step_id,verdict,results:[{event_name,layer,verdict,evidence_ids:[],checks:[],issues:[{code,path?,expected?,actual?,evidence_id}]}]}`. `src/spec/import.mjs`: `importSpec(filePath, {sheet?}={})` async => `{cases,warnings}`; JSON `{cases:[]}` as well as XLSX. `src/report/export.mjs`: `exportReports({session,cases,events,steps,results},outputDir)` async => `{xlsx,html,json,bugs}` absolute paths.

CDP agent: `src/collectors/cdp.mjs`: `CDPCollector` constructor `{port=9222,targetId?,urlFilter?,onEvent,onStatus?,endpointPatterns?}`; async `start(session)`, async `stop()`. Attach only localhost. Export `listTargets(port)` async. `src/browser/launcher.mjs`: async `launchBrowser({browser:'chrome'|'edge',port=9222,url?,profileDir?,executablePath?})` => `{process?,port,profileDir,executablePath}`. Export `findBrowser(browser)`. Do not terminate existing user browsers. `src/collectors/inject.js` injection script.

AI agent: `src/ai/openrouter.mjs`: `OpenRouterClient` constructor config defaults env; async `explain(result)` => `{available:boolean,note?,reason?}` with no verdict mutation; async `explainEvent({event,spec?,firing?,specLoaded?})` => `{available,verdict?,explanation?:{summary,problems[],next_steps[]},reason?}` where `verdict` is the local rule-engine verdict passed through unchanged; async `draftCase(input)` => `{available,case?,reason?}` always needs_review; async `listModels()`.

Root: `src/core/privacy.mjs`: export `redact(value)`, `redactUrl(url)`. `src/core/decoder.mjs`: export `decodeRequest({url,body='',contentType='',method='POST',requestId,status,source?})` => partial Event array (handles GA4 query+form+batch, Insider JSON/batches, UNPARSED with hash). `src/core/store.mjs`, `src/core/session.mjs`, local dashboard, CLI, demo fixtures, docs, integration tests.

All agents write their owned modules and tests only. No editing package.json or root files. Tests use node:test, run via npm.cmd test. No external requests except explicit AI use; no request replay or system proxy/CA modification.
