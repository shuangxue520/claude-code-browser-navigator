# Security Policy

This plugin is meant for local, user-authorized browser automation inside Claude Code.

## Boundaries

- The MCP server runs locally over Claude Code's plugin MCP transport.
- `connect_cdp` rejects non-localhost CDP endpoints unless you explicitly allow them.
- `launch_cdp` starts an isolated local Chrome/Edge profile by default.
- Request and response headers are redacted. Cookies, authorization headers, and similar secrets are stripped before anything reaches the model.
- Storage-state files can hold cookies and localStorage data. They are written only when you ask for them, and are ignored by `.gitignore`.

## Reporting

Report security bugs by opening a GitHub issue. Never include secrets, cookies, tokens, private URLs, or screenshots with private data in a public issue.

## Responsible Use

Only operate pages, accounts, and systems you own or are authorized to test. Don't use the plugin for unauthorized access, destructive actions, spam, credential theft, or evading security controls.
