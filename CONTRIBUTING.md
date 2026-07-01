# Contributing

Contributions are welcome, as long as they keep the plugin focused:

- Prefer compact, structured outputs over full DOM dumps.
- Prefer a handful of high-level tools over many narrow ones.
- Keep browser actions observable: after navigation or a mutation, return enough page state to verify what changed.
- Don't add telemetry, bundled credentials, or remote services.
- Keep runtime files out of git.

Before opening a pull request, run:

```powershell
node --check .\plugins\browser-navigator\mcp-server.js
node .\plugins\browser-navigator\mcp-server.js --self-test
claude plugin validate .\plugins\browser-navigator
```
