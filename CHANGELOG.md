# Changelog

## 1.1.1

- Improved `browser_session` `use_profile` so persistent profiles can fall back from Playwright's bundled Chromium to a detected or explicit system Chrome/Edge executable.
- Added self-test coverage for the persistent profile browser fallback path.

## 1.1.0

- Added `browser_session` action `launch_cdp` to start an isolated local Chrome/Edge debugging browser and connect automatically.
- Improved `connect_cdp` errors when no debugging endpoint is listening.
- Clarified `disconnect` versus `browser_close` behavior for CDP sessions.

## 1.0.0

- Added `browser_session` for status, persistent profiles, storageState save/load, CDP attach, and disconnect.
- Added session self-tests for storage state save/load.

## 0.9.0

- Added structured extraction helpers for links and forms.
- Added network wait and console inspection helpers.

## 0.8.0

- Added compact find/table extraction, hover, reload, and assertion helpers.

## 0.5.0 - 0.7.0

- Added file upload, element screenshots, dialog handling, download capture, iframe/page improvements, and page-level security snapshots.

## 0.1.0 - 0.4.0

- Initial focused browser MCP with compact page view, click/type/select/scroll, tab switching, JavaScript evaluation, and fetch/XHR capture.
