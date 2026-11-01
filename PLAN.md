# Antigravity IDE → OpenRouter: Extension Plan

A VS Code extension that adds OpenRouter models (any model OpenRouter serves) to the **native Antigravity agent chat model picker**, using the user's own OpenRouter API key.

Status: M0 recon complete; M1 (passthrough proxy), M2 (settings + language-server adapter), M3 (OpenRouter client + key + model manager), M4 (picker catalog injection — verified live) and M5 (Gemini ↔ OpenRouter translation, 17 unit tests) are implemented. Live end-to-end generation with an OpenRouter key is the next check.

---

## 0. Recon results — confirmed on Antigravity IDE 2.6.0 (VS Code 1.107.0 base)

Captured from real traffic on this machine (`captures/`, via `tools/capture-proxy.mjs`).

**Two hooks are required, not one:**

| Hook | What it covers |
|---|---|
| `jetski.cloudCodeUrl` user setting | Cloud Code calls made by the **Electron main process**: `loadCodeAssist`, `fetchAvailableModels`, `fetchUserInfo`, `fetchAdminControls`, `retrieveUserQuotaSummary`, `cascadeNuxes` |
| `SetCloudCodeURL` RPC on the **language server hub** | Chat generation: `streamGenerateContent` (the LS does its own Cloud Code traffic and ignores the setting) |

The LS is `%USERPROFILE%\.gemini\bin\agy.exe --hub --hub-port=NNNN --csrf_token=<uuid>`, a Connect-protocol server. `POST /exa.language_server_pb.LanguageServerService/SetCloudCodeURL` with `{"url": …}`, `content-type: application/json`, `connect-protocol-version: 1`, `x-codeium-csrf-token: <token>` → `200 {}`. It also accepts `--cloud_code_endpoint=<url>` at launch, but we cannot change that after the IDE spawns it.

**`jetski.cloudCodeUrl` cannot be written through the VS Code configuration API** ("not a registered configuration"). The extension edits `%APPDATA%\Antigravity IDE\User\settings.json` directly; the configuration service watches the file and the main process picks the value up live.

**Generation request:**

```json
{ "project": "aicode-consumers", "requestId": "agent/<cascade>/<ts>/<uuid>/<step>",
  "model": "gemini-4-argon-medium", "requestType": "agent" | "checkpoint",
  "userAgent": "antigravity",
  "request": {
    "contents": [{ "role": "user"|"model",
                   "parts": [{ "text" } | { "functionCall": { name, args } } |
                             { "functionResponse": { name, response } } | { "thoughtSignature" }] }],
    "systemInstruction": { "parts": [{ "text" }] },
    "tools": [{ "functionDeclarations": [{ "name", "description", "parameters": { "type": "OBJECT", … } }] }],
    "labels": { "cascade_id": …, "last_step_index": …, "model_enum": "MODEL_PLACEHOLDER_M418", … },
    "generationConfig": { "maxOutputTokens": 65536, "thinkingConfig": { "includeThoughts": true, "thinkingLevel": "MEDIUM" } },
    "sessionId": "-3750763034362895579" } }
```

Translation notes: tool results arrive as `role:"model"` + `functionResponse` (not OpenAI `role:"tool"`); JSON Schema types are uppercase proto enums; `requestType:"checkpoint"` (titles, summaries) uses native model ids and must keep passing through.

**Generation response (SSE, `?alt=sse`):**

```
data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"…"}]}, "finishReason":"STOP"}],
                   "usageMetadata":{"promptTokenCount":…,"candidatesTokenCount":…,"cachedContentTokenCount":…,"thoughtsTokenCount":…},
                   "modelVersion":"…","responseId":"…"},"traceId":"…","metadata":{}}
```

Parts seen: `{"text":…}`, `{"thought":true,"text":""}`, `{"thoughtSignature":…,"text":""}` (last frame, paired with `finishReason`).

**Model catalog (`fetchAvailableModels`) — the injection point:**

```json
{ "models": { "<picker id>": { "displayName", "model": "MODEL_PLACEHOLDER_M418",
                               "supportsImages","supportsThinking","minThinkingBudget","recommended",
                               "maxTokens","maxOutputTokens","quotaInfo","apiProvider","modelProvider",
                               "supportsVideo","tagTitle","supportedMimeTypes","thinkingLevel","modelExperiments" } },
  "defaultAgentModelId": "gemini-4-argon-medium",
  "agentModelSorts": [{ "displayName": "Recommended", "groups": [{ "modelIds": [...] }] }],
  "tieredModelIds": {...}, "experimentIds": [...], "commandModelIds": [...], … }
```

The `MODEL_PLACEHOLDER_M###` enum pool in the shipped `agy.exe` has **1651 values**; injected models take unused identities from it.

---

---

## 1. What is actually possible (research findings)

Verified from Google's docs and two projects that solved this (vahapogut/antigravity-add-model, Aminetwiti/antigravity-patch-proxy-remote):

**Antigravity "IDE" is a VS Code fork** (VS Code 1.107 base, `%LOCALAPPDATA%\Programs\Antigravity IDE`). The **desktop App** (`%LOCALAPPDATA%\Programs\antigravity`, Electron + `app.asar`) is a different product: it cannot load extensions, only binary patches.

In the IDE, the chat model list and all agent traffic come from Google's internal Cloud Code API (`v1internal`), called by the Antigravity language server:

| Endpoint | Purpose |
|---|---|
| `POST /v1internal:loadCodeAssist` | account / tier / endpoint selection |
| `POST /v1internal:fetchAvailableModels` | **model catalog that builds the picker** |
| `POST /v1internal:streamGenerateContent?alt=sse` | streaming chat + tool calls |
| `POST /v1internal:generateContent` | non-streaming (titles, summaries, compaction) |
| `POST /v1internal:listExperiments` | feature flags |

Request envelope:

```json
{ "project": "...", "requestId": "...",
  "model": "<model id>",
  "request": { "contents": [...], "systemInstruction": {...},
               "tools": [...], "generationConfig": {...} } }
```

Response envelope (SSE frames): `{"response": { <Gemini GenerateContentResponse> }, "traceId": "...", "metadata": {}}`

**The hook:** the IDE honours the user setting `jetski.cloudCodeUrl`. Point it at `http://127.0.0.1:<port>` and the language server talks to a local proxy instead of `daily-cloudcode-pa.googleapis.com`. No vendor files are modified, and the change is one setting that can be reverted.

So the extension is:

1. an HTTP/SSE proxy on loopback that is started by the extension host,
2. the `jetski.cloudCodeUrl` setting write/restore,
3. model-catalog injection so custom models appear in the native picker,
4. Gemini ↔ OpenRouter/OpenAI translation, both directions, streaming, with tool calls,
5. native Google models keep passing straight through to Google with the user's existing login.

This is exactly what the user asked for: the *original* agent chat, *original* UI, extra models.

---

## 2. Architecture

```
Antigravity IDE
  ├─ chat UI  ──────────────►  language server (Go)
  │                                  │  jetski.cloudCodeUrl
  │                                  ▼
  │                        http://127.0.0.1:57331  (extension host)
  │                                  │
  │                     ┌────────────┴─────────────┐
  │                     │  router (by model id)     │
  │                     ▼                          ▼
  │            native model?                 custom model?
  │                     │                          │
  │            passthrough (SSE pipe)       translate + OpenRouter
  │                     ▼                          ▼
  │        daily-cloudcode-pa.googleapis.com   openrouter.ai/api/v1
  │        (user's Google OAuth, untouched)    (user's OpenRouter key)
```

Extension internals:

```
src/
  extension.ts                 activate/deactivate, commands, wiring
  adapter/cloudCodeSetting.ts   read/write/restore jetski.cloudCodeUrl (with backup)
  proxy/server.ts               node:http server, routing, health, auth handling
  proxy/passthrough.ts          streaming forward to Google, header/body preserved
  proxy/catalog.ts              fetchAvailableModels: inject custom models, fail-open
  proxy/modelIds.ts             stable native enum id <-> alias mapping (globalState)
  proxy/translate/request.ts    Gemini -> OpenAI chat/completions
  proxy/translate/response.ts   OpenAI SSE -> Cloud Code envelope SSE
  proxy/translate/tools.ts      functionDeclarations <-> tools/tool_calls, id pairing
  proxy/translate/images.ts     inlineData <-> image_url (when model supports vision)
  openrouter/client.ts          /models list, /chat/completions SSE, abort propagation
  openrouter/registry.ts        user config, alias table, fallback chains
  ui/statusBar.ts               proxy state, active model, last request cost
  ui/settingsWebview.ts         API key, model picker (multi-select from live catalog)
  ui/inspectorWebview.ts        last N requests: model, latency, tokens, errors, redacted bodies
  util/{log,redact,jsonRepair}.ts
test/fixtures/                  recorded Cloud Code + OpenRouter payloads (golden files)
```

Server runs **inside the extension host** (Node), bound to `127.0.0.1`, port configurable, default `57331`, falls back to next free port and rewrites the setting.

---

## 3. Prerequisites / constraints

- **Antigravity IDE edition must be installed.** Only the desktop App is installed on this machine right now (`C:\Users\PERSONAL\AppData\Local\Programs\antigravity`). The extension cannot touch the App.
- Extension loads as **`.vsix`** (Install from VSIX). Publishing to Open VSX is optional later.
- Toolchain: Node 24 present, `npm.ps1` is blocked by execution policy → use `npm.cmd` or `-ExecutionPolicy Bypass` in scripts.
- **Cold-start ordering:** the language server may fetch models before extensions activate. Mitigation: setting is only written while the proxy is healthy; on a failed cold start the extension shows "Proxy ready — Reload Window" and offers a one-click reload.
- **Version fragility:** endpoint shapes can change between IDE releases. Everything is fail-open (unparsed catalog → return upstream bytes unchanged; proxy failure → auto-restore setting + native-only mode).

Not in scope: patching `app.asar`, patching the language server binary, MITM with custom certificates, Google quota pooling, multi-account Google rotation, mobile/remote control.

---

## 4. Milestones

### M0 — Recon (blocking, do first)
1. Install Antigravity IDE; record version + VS Code base from `resources/app/product.json`.
2. Inspect the unpacked app JS (`resources/app/out/**`, bundled extensions) for `cloudCodeUrl`, `fetchAvailableModels`, `streamGenerateContent`; capture exact setting names and any hardcoded host.
3. Run a throwaway capture proxy (plain Node script, no extension) and record real traffic for: sign-in, model list, chat turn, tool call, tool result, compaction, cancel. Redact `Authorization`, truncate bodies to fixtures.
4. Diff against the two prior-art projects' notes to see what this build does differently.

**Acceptance:** a fixtures folder with ≥6 recorded exchanges and a confirmed list of field names for this exact build. If `jetski.cloudCodeUrl` is ignored by this build, stop and report before M1 (fallback would be a binary patch, out of scope).

### M1 — Skeleton + full passthrough
- Extension manifest (`engines.vscode` matching the IDE base), esbuild bundle, watch mode, launch profile.
- Proxy with health endpoint, structured logging, redaction.
- Passthrough of every `v1internal:*` call, including SSE, headers, and body byte-for-byte.

**Acceptance:** with the setting pointed at the proxy, the IDE behaves exactly as before: sign-in works, native models listed, streaming chat works, tool calls work, cancel works.

### M2 — Settings adapter
- Commands: `Antigravity: Enable OpenRouter Proxy`, `Disable`, `Repair/Restart`, `Reload Window`.
- Write/restore `jetski.cloudCodeUrl` at User scope with a backup file + hash check (refuse to clobber a value it did not set).
- Auto-disable on crash; restore on `deactivate` and on uninstall.

**Acceptance:** enable → traffic hits proxy (log proves it); disable → exact original settings bytes; kill proxy → setting auto-restored, IDE keeps working.

### M3 — OpenRouter connection + model config
- API key in `context.secrets` (OS keychain), never in settings or logs.
- Fetch `https://openrouter.ai/api/v1/models`, cache 24 h, show price/context/vision/tools flags.
- Settings webview: paste key, "Test key", search + multi-select models, per-model alias/display name, optional per-model overrides.
- Config shape:

```jsonc
{
  "antigravityOpenRouter.models": [
    { "alias": "or-claude-sonnet-4.5",
      "displayName": "Claude Sonnet 4.5 (OpenRouter)",
      "modelId": "anthropic/claude-sonnet-4.5",
      "contextLength": 200000, "maxOutputTokens": 64000,
      "vision": true, "reasoningEfforts": ["low", "medium", "high"],
      "providerPrefs": { "order": ["anthropic"], "allow_fallbacks": true },
      "fallbackModel": "google/gemini-2.5-flash" }
  ]
}
```

**Acceptance:** key validated, ≥3 OpenRouter models saved, catalog cached, key visible only in the webview as masked.

### M4 — Picker injection
- Intercept `fetchAvailableModels`; append each configured model to the model map and to `agentModelSorts` groups.
- Native id per model: `MODEL_PLACEHOLDER_<djb2(alias)>`, persisted in an identity map so selections survive restarts and renamed display names.
- Cap the number of injected models to the native placeholder capacity of the build; warn when exceeded (mirror prior art's finding of ~651 placeholder enum slots).
- Fail-open: any parse/validation error → return the original response untouched and log why.

**Acceptance:** custom models appear in the real picker next to Gemini/Claude, selectable, and the selection is stable after IDE restart.

### M5 — Generation translation (core)
Request, stateless per turn (the agent resends full history):
- `systemInstruction.parts[].text` → `messages[0]` system.
- `contents[]` → messages by role; `text` → content; `inlineData` → `image_url` data URI (only when the model has vision, else replaced with a short placeholder note).
- Tool loop: walk `contents` in order; a `functionCall` part becomes an assistant `tool_calls` entry with a synthesized id `call_<contentIndex>_<partIndex>`; each following `functionResponse` becomes a `tool` message referencing that id. Handles 1:N calls per turn and interleaved text.
- `tools[].functionDeclarations[]` → `tools[] = { type: "function", function: {...} }`; JSON Schema is already compatible.
- `generationConfig` → `temperature`, `top_p`, `max_tokens`; `thinkingConfig.thinkingBudget`/`thinkingLevel` → OpenRouter `reasoning.effort` (`low|medium|high`), omitted for non-reasoning models.
- Drop Google-only parts (`thoughtSignature`, `executableCode`, `codeExecutionResult`, artifact metadata) for custom models; keep them for native passthrough.

Response:
- OpenRouter SSE → Cloud Code SSE frames `{"response":{"candidates":[{"content":{"role":"model","parts":[...]},"finishReason":...}],"usageMetadata":{...}},"traceId":...}`.
- Incremental text deltas; tool-call argument accumulation, emitted as one `functionCall` part when the stream closes the call; `finishReason: STOP | MAX_TOKENS | SAFETY`.
- `usageMetadata`: prompt/completion/total/cached token counts from OpenRouter usage (streaming `usage: {include: true}`).
- Errors mapped to something the agent surfaces readably: 401 → "OpenRouter key invalid", 402 → "insufficient credits", 429 → "rate limited, retry", context overflow → "context too long", network → "provider unreachable". No silent empty replies.
- Abort propagation: IDE cancels → abort the upstream fetch immediately.
- `generateContent` (non-stream) covered by the same translator for titles/summaries/compaction.

**Acceptance (live, not mocked):** a text question answered by an OpenRouter model inside the native chat; a real multi-step task that reads a file (agent tool call → result → final answer); a cancel mid-stream; a forced 401 shows a readable error; a native Gemini turn still works in the same session.

### M6 — UX, diagnostics, resilience
- Status bar: proxy up/down, model in use, last latency + token cost.
- Inspector webview: request list, timing, token counts, redacted request/response diff, copy-as-fixture button (feeds M7 tests).
- Timeout per request (configurable, default 120 s), concurrency limit, circuit breaker per model.
- Optional fallback chain: on 429/5xx, retry once with `fallbackModel` and inject a one-line notice into the stream.
- Auto-start of the proxy on activation; restart on crash; port collision handled.

### M7 — Tests, packaging, docs
- Unit tests (vitest) for request/response translators against recorded fixtures, incl. tool-call pairing, images, reasoning effort, error mapping, catalog injection.
- A mock OpenRouter SSE server for integration tests; mocked Google upstream for passthrough tests.
- Compatibility matrix: record IDE build → supported / unsupported, plus a startup check that warns on an untested build.
- `vsce package` → `antigravity-openrouter-<ver>.vsix`; `README` with install, revert, limitations; `CHANGELOG`.

---

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Build ignores `jetski.cloudCodeUrl` | Feature impossible without patching | Verified in M0 before any build work |
| Internal API shapes change on IDE update | Picker injection / chat breaks | Fail-open everywhere, fixture tests, version banner, auto-restore setting |
| Tool-call semantics differ (ids, parallel calls, ordering) | Agent loops break | Recorded real traffic + golden tests + live multi-step acceptance |
| Gemini-only parts (thought signatures, artifacts) | IDE may reject responses | Strip for custom models; keep for native; validate against real agent runs |
| Cold start before extension activates | `ECONNREFUSED` on launch | Setting only valid while proxy healthy + "Reload Window" action |
| Provider/model mismatch (model without tool support) | Broken agent behaviour | Flag tool support from OpenRouter metadata; warn at selection time |
| Credential exposure | Key leak | OS keychain only, redaction in all logs, no key in exported fixtures |
| ToS / account risk | Google account flagging | Extension adds models only; it never proxies Google traffic elsewhere or bypasses Google auth/quota. Document that the proxy is local and reversible, and that upstream terms should be reviewed |

---

## 6. Effort estimate

| Milestone | Rough size |
|---|---|
| M0 recon | 1–2 days (needs the IDE installed) |
| M1 passthrough | 1 day |
| M2 settings adapter | 0.5 day |
| M3 OpenRouter config UI | 1–1.5 days |
| M4 picker injection | 1–2 days (schema-dependent) |
| M5 translation | 2–4 days (mostly tool-call and streaming edge cases) |
| M6 UX/diagnostics | 1 day |
| M7 tests/packaging/docs | 1–2 days |

Ship order: M0 → M1 → M2 gives a working, revertible safety net early; M5 is the risky part and should start immediately after M3 with recorded traffic, before M4 polish.

---

### M8 — Fallback agent panel (companion, off by default)
Own chat view inside the same IDE that talks to OpenRouter directly, with no dependency on `jetski.cloudCodeUrl` or any `v1internal` schema.

- Webview chat: streaming markdown, per-message model switch, stop button, history in `globalStorage`.
- Tools: read file, list/glob/grep, write/patch file, run terminal command with approval, optional MCP passthrough.
- Reuses `openrouter/client.ts`, `openrouter/registry.ts`, and the inspector; only the UI + loop are new.
- Purpose: insurance. If a future IDE build breaks the native hook, OpenRouter still works inside Antigravity with one command.

**Acceptance:** a multi-step task (read → patch → run tests) completes from the fallback panel with no proxy running.

---

## 7. Decisions (resolved)

1. **Edition:** Antigravity **IDE**. The desktop App is out of scope; no `app.asar` or binary patching.
2. **Model exposure:** **curated favorites** (10–20 picked in the settings UI). Full OpenRouter catalog stays browsable/searchable in the webview; only favorites get injected into the native picker, which also keeps us well under the placeholder-slot limit.
3. **Fallback panel:** **yes, M8** (after M7), off by default.

## 8. Start order

M0 needs the IDE installed. M1 (passthrough) and M2 (settings adapter) make no assumptions about request schemas and can be built before the IDE is available, then verified once it is:

1. install Antigravity IDE,
2. scaffold extension + passthrough proxy + settings adapter (M1, M2),
3. run M0 capture against the installed build,
4. build M3–M5 against the recorded fixtures,
5. M6–M8.
