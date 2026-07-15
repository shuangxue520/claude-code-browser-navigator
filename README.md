# browser-navigator

![Version](https://img.shields.io/badge/version-1.2.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A Claude Code plugin that drives a real local browser through MCP.

browser-navigator is built for text-first models that need to work with live web pages without loading a whole DOM into context. Instead of dumping raw HTML, it returns compact element refs, structured extractions, and purpose-built actions, so the model can read a page, click, type, watch network traffic, and confirm what changed with minimal token overhead.

## What It Does

- Open real pages in Chromium, Chrome, or Edge.
- Track multiple tabs and switch between them.
- Return a compact view of visible text, refs, inputs, buttons, links, and bounding boxes.
- Search within a page and get back short snippets with ready-to-use refs.
- Extract links, forms, and HTML tables as bounded, structured output.
- Click, hover, type, select dropdowns, press keys, upload files, scroll, wait, reload, and navigate back.
- Handle native alert, confirm, and prompt dialogs.
- Capture full-page or single-element screenshots.
- Capture downloads triggered by clicks, and list recent download records.
- Inspect fetch/XHR requests, response previews, and console output.
- Run JavaScript in the page for compact DOM or app-state reads.
- Reuse sessions through persistent profiles or saved Playwright storage state.
- Launch an isolated local Chrome/Edge CDP browser when you need one, or connect to a trusted local CDP endpoint you already have running.
- Snapshot a page's security posture: readable security headers, cookie flags, forms, mixed content, iframes, resources, storage keys, and recent XHR/fetch.

## Install

This repository is a Claude Code marketplace. It contains one plugin: `browser-navigator`.

In Claude Code, run:

```text
/plugin marketplace add shuangxue520/claude-code-browser-navigator
/plugin install browser-navigator@browser-navigator-marketplace
/reload-plugins
```

After adding the marketplace, you can also open `/plugin` and install `browser-navigator` from the plugin UI.

To run the plugin from a local clone:

```powershell
git clone https://github.com/shuangxue520/claude-code-browser-navigator.git
cd claude-code-browser-navigator
claude --plugin-dir .\plugins\browser-navigator
```

## Requirements

- Claude Code with plugin support.
- Node.js on your `PATH`.
- Playwright reachable from Node.js. Claude Code's plugin runtime often ships it; if not, install it in your environment.
- A Chrome or Edge executable. This is optional, and only needed for `browser_session` `launch_cdp`.

No API keys required.

## Typical Use

Open a page:

```json
{ "url": "https://example.com", "visible": true }
```

Search or extract before increasing view limits:

```json
{ "query": "pricing", "maxMatches": 10 }
```

Use structured page helpers:

```json
{ "textContains": "docs", "maxItems": 20 }
{ "selector": "form" }
{ "selector": "table", "maxRows": 50 }
```

Use session continuity when login state matters:

```json
{ "action": "status" }
{ "action": "use_profile", "profileName": "work", "url": "https://example.com" }
{ "action": "save_storage", "name": "work" }
{ "action": "load_storage", "name": "work", "url": "https://example.com" }
```

Let the plugin manage CDP when you want a debugging browser but would rather not start one by hand:

```json
{ "action": "launch_cdp", "browser": "auto", "profileName": "debug", "url": "https://example.com" }
```

Use `connect_cdp` only for a browser you deliberately started with a local remote-debugging endpoint:

```json
{ "action": "connect_cdp", "endpointURL": "http://127.0.0.1:9222" }
```

## Tool Design

browser-navigator is opinionated by design. It favors:

- compact outputs over full DOM dumps
- refs over fragile selectors wherever possible
- a few dedicated tools for common browser tasks
- bounded network, console, screenshot, and extraction results
- runtime state that stays local, under `.browser-navigator/`

That makes it a good fit for models that reason well step by step but get slow or unreliable when flooded with large page dumps.

## Safety And Privacy

- The plugin runs entirely on your machine.
- No telemetry, no bundled API keys.
- It never uploads page content, screenshots, cookies, or storage state on its own.
- `save_storage` can write cookies, localStorage, and session data to local files. Treat those files as sensitive.
- Runtime files are excluded by `.gitignore`.
- Non-local CDP endpoints are refused unless you explicitly allow them.
- Sensitive request headers, such as cookies and authorization headers, are redacted in tool output.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Development Checks

```powershell
node --check .\plugins\browser-navigator\mcp-server.js
node .\plugins\browser-navigator\mcp-server.js --self-test
claude plugin validate .\plugins\browser-navigator
```

The self-test spins up local test pages, exercises the browser tools, checks managed CDP launch when Chrome or Edge is available, and writes temporary runtime files under `.browser-navigator/`.

## License

MIT. See [LICENSE](LICENSE).
