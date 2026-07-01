---
description: Manually browse and operate a real local browser through the browser_navigator MCP server. Use for reading webpage content, opening page directories/menus, clicking links/buttons, typing forms, waiting for page changes, and checking what is currently visible.
disable-model-invocation: true
argument-hint: "[url-or-task]"
---

# Browser Navigator

Browse for: `$ARGUMENTS`

Use this skill as a text-first operating loop for a real browser. The goal is to see what is currently on the webpage and operate it, not to generate a broad report.

## Operating Loop

1. If login/session reuse matters, start with `mcp__browser_navigator__browser_session` using `status`. Use `use_profile` for a persistent plugin-managed browser profile, `load_storage` for saved cookies/localStorage, `launch_cdp` when a fresh isolated CDP browser is needed, or `connect_cdp` only when the user intentionally started a trusted local debugging browser.
2. Call `mcp__browser_navigator__browser_open` for a new URL. Use `visible: true` when the user wants to watch the browser operate.
3. Call `mcp__browser_navigator__browser_view` after every navigation or action.
4. If you only need to find a term or section, call `mcp__browser_navigator__browser_find` before raising `browser_view` limits.
5. For navigation choices, call `mcp__browser_navigator__browser_extract_links`; for forms, call `mcp__browser_navigator__browser_extract_forms`; for tables, call `mcp__browser_navigator__browser_extract_table`.
6. Choose actions from returned refs whenever possible.
7. Use `mcp__browser_navigator__browser_click` for links, buttons, menu items, and directory entries.
8. Use `mcp__browser_navigator__browser_hover` when menus or panels appear only on hover.
9. If a click opens a new tab/page, continue from the returned view. If the active page still looks wrong, call `mcp__browser_navigator__browser_pages`, then `mcp__browser_navigator__browser_switch_page` with `latest: true`, a page `ref`, or a URL/title substring.
10. Use `mcp__browser_navigator__browser_type`, `mcp__browser_navigator__browser_select`, `mcp__browser_navigator__browser_upload`, and `mcp__browser_navigator__browser_press` for forms, dropdowns, file inputs, and search boxes.
11. Use `mcp__browser_navigator__browser_scroll` for page or scrollable-panel movement; do not hand-write scrolling JavaScript unless the tool cannot reach the target.
12. Use `mcp__browser_navigator__browser_wait` when content loads after clicking.
13. Use `mcp__browser_navigator__browser_assert` to verify a page state in lightweight QA tasks.
14. Use `mcp__browser_navigator__browser_network_wait` immediately after actions that should trigger a specific API call; use `browser_network` and `browser_network_get` when the list/details matter.
15. Use `mcp__browser_navigator__browser_console` when frontend errors/logs matter.
16. Use `mcp__browser_navigator__browser_evaluate` for read-only DOM/state extraction or same-origin `fetch` calls that need the page's browser session.
17. Use `mcp__browser_navigator__browser_back` when the current path is wrong; use `mcp__browser_navigator__browser_reload` when the page is stale.
18. Use `mcp__browser_navigator__browser_dialog` before actions that may trigger alert/confirm/prompt.
19. Use `browser_click` with `expectDownload: true` for export/download buttons, then `mcp__browser_navigator__browser_downloads` if the saved path or status needs to be recalled.
20. Use `mcp__browser_navigator__browser_screenshot` only when a saved screenshot is useful; pass `ref` or `selector` for element screenshots.
21. For page-level defensive security review, call `mcp__browser_navigator__browser_security_snapshot` after the page is open. Use `security-doctor` for TLS, DNS, ports, dependency audits, or server-side header checks.

## Page JavaScript and Network

- `browser_evaluate` runs JavaScript in the active page, so it can read `document`, app state, and call same-origin APIs with the page's cookies/session.
- Prefer expressions that return compact JSON, such as `Array.from(document.querySelectorAll("a")).map(a => ({text: a.innerText, href: a.href}))`.
- For async API reads, use an async expression: `(async () => await fetch("/api/items").then(r => r.json()))()`.
- Do not use `browser_evaluate` for destructive actions such as purchases, account changes, POST/PUT/DELETE, or form submission unless the user explicitly asks.
- `browser_network` lists captured `fetch`/`xhr` entries. Use `browser_network_get` on an entry id when request body, response preview, or redacted headers are needed.
- Call `browser_network_clear` before a focused interaction if old entries would make the result ambiguous.
- `browser_view` includes viewport, scroll position, focused element, refs, and bounding boxes. Use those facts before guessing selectors.
- `browser_find`, `browser_extract_links`, `browser_extract_forms`, and `browser_extract_table` are the preferred low-token extraction tools. Increase their optional limits only when the first result is not enough.
- `browser_assert` is for quick checks. If it fails, inspect with `browser_view` or `browser_find` before retrying actions.
- `browser_network_wait` is better than repeatedly polling `browser_network` when you know the URL/status/method pattern to expect.
- `browser_console` is the replacement for DevTools Console in Claude Code; filter levels instead of dumping every log.
- `browser_dialog` arms the next dialog handler and records the last dialog. Unexpected dialogs are dismissed to avoid blocking the browser.
- `browser_upload` can use project-relative paths or explicit absolute paths. Only upload files the user intentionally asked to use.
- `browser_downloads` reports recent captured downloads; use artifact/document tools to inspect the downloaded file content.
- `browser_screenshot` can capture an element by `ref`/`selector`, which is useful for saving a table, chart, or result panel without extra page chrome.
- `browser_session` manages continuity. Do not print storage state contents. Treat saved storage files as sensitive because they can contain cookies and localStorage tokens.
- Prefer plugin-managed `profileName` profiles over arbitrary `userDataDir`. Use external profiles only when the user explicitly asks.
- Prefer `launch_cdp` over asking the user to manually run a browser command. It starts an isolated Chrome/Edge profile, chooses a local port, waits for readiness, and connects in one call.
- `connect_cdp` should normally use localhost endpoints such as `http://127.0.0.1:9222`; use it only for a browser already started with remote debugging. Do not connect to remote CDP endpoints unless the user explicitly trusts that endpoint.
- `browser_security_snapshot` summarizes readable security headers, cookie flags, forms, mixed content, iframes, cross-origin scripts, storage keys, and recent XHR/fetch. It does not run exploit payloads.

## DeepSeek Constraints

- DeepSeek cannot directly inspect image/document prompt blocks through the Anthropic-compatible API.
- Treat screenshots as files unless OCR/vision is separately available.
- DeepSeek cannot rely on DevTools/F12. Use `browser_view`, `browser_network`, and `browser_evaluate` instead of claiming to inspect hidden panels.
- Do not infer hidden visual details. Base webpage claims on `browser_view`, page text, links, inputs, console logs, network captures, evaluated page state, and observed navigation.

## Answer Style

- Keep the user oriented: current URL, what is visible, and the next action.
- Prefer acting through refs over guessing selectors.
- Do not say an action worked until `browser_view` confirms the changed page state.
