# Antigravity OpenRouter

Adds OpenRouter models to the native Google Antigravity agent chat.

Antigravity IDE ships with a fixed model list. This extension serves the Cloud Code
model catalog through a local proxy and appends the OpenRouter models you choose,
so they show up in the real picker, in the real agent loop, with tool calls,
streaming, images and reasoning intact. Native Gemini/Claude models keep going to
Google untouched.

## How it works

The IDE has two places that talk to Google's Cloud Code API:

| Hook | Covers |
| --- | --- |
| `jetski.cloudCodeUrl` user setting | catalog / account calls from the Electron main process |
| `SetCloudCodeURL` RPC on the language-server hub | chat generation (`streamGenerateContent`) |

The extension starts a loopback proxy, points both hooks at it, and rewrites only
the requests whose model id belongs to an injected entry. Everything else is
forwarded byte-for-byte.

## Install

Download `antigravity-openrouter-0.0.1.vsix` from the [latest release](https://github.com/Galantryas/antigravity-openrouter/releases) and install it:

```bash
code --install-extension antigravity-openrouter-0.0.1.vsix
```

Or build it yourself with `npm install && npm run package`.

## Setup

1. `Antigravity OpenRouter: Open settings panel` (or click the status bar item).
2. Paste your OpenRouter API key â†’ **Save key** (stored in the OS credential
   store, never in `settings.json` or logs).
3. **Add from OpenRouter** â†’ search â†’ select models â†’ **Add selected**.
4. Reload the window; the models appear in the Antigravity picker under
   "OpenRouter".

## Turning it off

`Antigravity OpenRouter: Disable` restores the original `jetski.cloudCodeUrl`
value (or removes it if it was unset) and puts the language server back on the
Google endpoint.

## Notes

- The proxy binds to `127.0.0.1` only.
- Provider failures are reported as a normal assistant message, so the agent never
  retries in a loop. Four failures in 15 s trip a short circuit breaker.
- Internal Cloud Code shapes can change between Antigravity releases. The proxy
  fails open: if the catalog cannot be parsed, the upstream response is returned
  untouched, and native models keep working.

## Commands

- `Open settings panel (API key & models)`
- `Set OpenRouter API key`
- `Test OpenRouter connection`
- `Add OpenRouter models to the picker`
- `Remove OpenRouter models`
- `Enable OpenRouter routing` / `Disable OpenRouter routing`
- `Restart proxy and re-attach language server`
- `Show log`

