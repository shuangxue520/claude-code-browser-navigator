# Privacy

browser-navigator is local-first.

- It ships no analytics, telemetry, or bundled API keys.
- On its own, it never uploads screenshots, page content, cookies, or storage state to any third-party service.
- When you call a tool, it returns compact text summaries, selected DOM details, network metadata, console messages, and saved file paths to your Claude Code session, and nothing more.
- `browser_session`'s `save_storage` writes cookies, localStorage, and session data to local files, and only when you explicitly ask for it.
- Runtime files live under `.browser-navigator/` by default and are ignored by this repository.

When you work on authenticated sites, treat the browser output as sensitive: review generated logs and screenshots before sharing them.
