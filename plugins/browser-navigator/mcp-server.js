#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const SERVER_NAME = "browser_navigator";
const SERVER_VERSION = "1.1.0";
const ROOT = path.resolve(process.env.BROWSER_NAVIGATOR_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const REF_ATTR = "data-claude-browser-ref";
const pageRefs = new WeakMap();
const pageEventsAttached = new WeakSet();
const requestEntries = new WeakMap();
const TRACKED_NETWORK_TYPES = new Set(["fetch", "xhr"]);

const state = {
  playwright: null,
  browser: null,
  context: null,
  page: null,
  pages: [],
  pageSeq: 0,
  contextEventsAttached: false,
  visible: true,
  viewport: { width: 1280, height: 800 },
  consoleLogs: [],
  networkLogs: [],
  networkEntries: [],
  networkSeq: 0,
  downloads: [],
  downloadSeq: 0,
  pageErrors: [],
  dialogPolicy: null,
  lastDialog: null,
  browserKind: "none",
  profileDir: "",
  storageStatePath: "",
  cdpEndpoint: "",
  cdpProcess: null,
  cdpLaunchedByPlugin: false,
  cdpLaunchInfo: null
};

const tools = [
  {
    name: "browser_open",
    description: "Open a URL or local file in a real browser. Defaults to a visible browser window.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL, localhost address, data URL, or project-relative file path." },
        visible: { type: "boolean", description: "Open a visible browser window when true. Default true." },
        width: { type: "integer", minimum: 320, maximum: 3840 },
        height: { type: "integer", minimum: 240, maximum: 2160 },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Navigation wait strategy. Default domcontentloaded." }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "browser_view",
    description: "Return the current page URL, title, visible text, clickable refs, input refs, recent console errors, and failed network requests.",
    inputSchema: {
      type: "object",
      properties: {
        maxTextLines: { type: "integer", minimum: 10, maximum: 300 },
        maxElements: { type: "integer", minimum: 10, maximum: 300 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_find",
    description: "Search the current page for text and return compact nearby snippets with element refs and boxes. Use before increasing browser_view limits or dumping DOM.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex-like literal to search for in visible page text and form values." },
        matchCase: { type: "boolean", description: "Case-sensitive match. Default false." },
        selector: { type: "string", description: "Optional CSS selector to narrow the search region." },
        maxMatches: { type: "integer", minimum: 1, maximum: 80, description: "Max matches to return. Default 12." },
        contextChars: { type: "integer", minimum: 20, maximum: 1000, description: "Snippet context length around the match. Default 160." },
        includeInputs: { type: "boolean", description: "Also search input/textarea/select values and placeholders. Default true." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "browser_extract_table",
    description: "Extract a visible HTML table by ref, selector, or index into compact Markdown or JSON. Use for tables instead of copying page text.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Optional table ref from browser_view/browser_find." },
        selector: { type: "string", description: "Optional CSS selector for a table." },
        index: { type: "integer", minimum: 0, description: "Zero-based visible table index when ref/selector is omitted. Default 0." },
        format: { type: "string", enum: ["markdown", "json"], description: "Output format. Default markdown." },
        maxRows: { type: "integer", minimum: 1, maximum: 500, description: "Maximum body rows to return. Default 40." },
        maxCols: { type: "integer", minimum: 1, maximum: 80, description: "Maximum columns to return. Default 20." },
        maxCellChars: { type: "integer", minimum: 20, maximum: 2000, description: "Maximum characters per cell. Default 160." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_extract_links",
    description: "Extract visible links into a compact list with refs, text, URL, origin type, and boxes. Use for directories, menus, search results, and navigation planning.",
    inputSchema: {
      type: "object",
      properties: {
        textContains: { type: "string", description: "Only include links whose visible text contains this text." },
        urlContains: { type: "string", description: "Only include links whose URL contains this text." },
        sameOrigin: { type: "boolean", description: "Only include same-origin links." },
        external: { type: "boolean", description: "Only include cross-origin links." },
        selector: { type: "string", description: "Optional CSS selector to narrow the search region." },
        includeHidden: { type: "boolean", description: "Include hidden/offscreen links. Default false." },
        maxItems: { type: "integer", minimum: 1, maximum: 200, description: "Max links to return. Default 40." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_extract_forms",
    description: "Extract compact form structure: method/action, field refs, names, labels, required flags, file/password fields, and csrf-like fields.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Optional CSS selector to narrow forms." },
        includeHidden: { type: "boolean", description: "Include hidden fields. Default true." },
        maxForms: { type: "integer", minimum: 1, maximum: 50, description: "Max forms to return. Default 10." },
        maxFields: { type: "integer", minimum: 1, maximum: 300, description: "Max fields total to return. Default 80." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_evaluate",
    description: "Run JavaScript in the active browser page context and return the serialized result. Useful for reading DOM state or calling same-origin APIs with the page session.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "JavaScript expression or function body. Expressions are returned; statements can use return." },
        arg: { description: "Optional JSON-serializable argument available as arg inside the script." },
        awaitPromise: { type: "boolean", description: "Await a returned Promise. Default true." },
        maxChars: { type: "integer", minimum: 1000, maximum: 200000, description: "Maximum characters returned. Default 20000." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 60000, description: "Timeout for the evaluation. Default 15000." }
      },
      required: ["script"],
      additionalProperties: false
    }
  },
  {
    name: "browser_network",
    description: "List recent fetch/XHR network entries captured from browser pages, with IDs for details.",
    inputSchema: {
      type: "object",
      properties: {
        maxEntries: { type: "integer", minimum: 1, maximum: 100 },
        resourceTypes: { type: "array", items: { type: "string" }, description: "Resource types to include, such as fetch or xhr. Default fetch,xhr." },
        urlContains: { type: "string", description: "Only include entries whose URL contains this text." },
        statusMin: { type: "integer", minimum: 100, maximum: 599 },
        includeHeaders: { type: "boolean" },
        includeBodies: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_network_get",
    description: "Return details for one captured network entry by ID, including redacted headers and optional body previews.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Network entry ID from browser_network, such as n3." },
        includeHeaders: { type: "boolean", description: "Include redacted request/response headers. Default true." },
        includeBodies: { type: "boolean", description: "Include request/response body previews. Default true." },
        maxBodyChars: { type: "integer", minimum: 1000, maximum: 200000 }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "browser_network_clear",
    description: "Clear captured browser network entries and recent network issue logs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "browser_network_wait",
    description: "Wait for a captured fetch/XHR entry matching URL/status/method/resource filters, then return its compact summary. Use after clicking when data loads asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        urlContains: { type: "string", description: "Only match entries whose URL contains this text." },
        method: { type: "string", description: "HTTP method to match, such as GET or POST." },
        resourceTypes: { type: "array", items: { type: "string" }, description: "Resource types to include. Default fetch,xhr." },
        status: { type: "integer", minimum: 100, maximum: 599, description: "Exact response status to match." },
        statusMin: { type: "integer", minimum: 100, maximum: 599, description: "Minimum response status to match." },
        includeBodies: { type: "boolean", description: "Include compact request/response body previews. Default false." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000, description: "Wait timeout. Default 10000." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_console",
    description: "List recent browser console messages and page errors with level filtering. Use when debugging frontend failures without opening DevTools.",
    inputSchema: {
      type: "object",
      properties: {
        levels: { type: "array", items: { type: "string" }, description: "Console levels to include, such as error, warning, log, info, debug. Default error,warning,assert." },
        includePageErrors: { type: "boolean", description: "Include uncaught page errors. Default true." },
        maxEntries: { type: "integer", minimum: 1, maximum: 100, description: "Max entries. Default 20." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_downloads",
    description: "List recent files downloaded through browser_click expectDownload, including saved path, size, source URL, and status.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_pages",
    description: "List all open browser tabs/pages and show which one is currently active.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "browser_session",
    description: "Manage browser connection/session state: status, persistent profiles, storageState save/load, plugin-launched CDP browser, existing Chrome DevTools Protocol connection, and disconnect. Use when login/session reuse matters.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "use_profile", "save_storage", "load_storage", "launch_cdp", "connect_cdp", "disconnect"],
          description: "Session action. status is read-only. use_profile launches a persistent Playwright profile. save/load_storage stores cookies/localStorage. launch_cdp starts an isolated Chrome/Edge debug browser then connects. connect_cdp attaches to an existing debug endpoint."
        },
        browser: { type: "string", enum: ["auto", "edge", "chrome"], description: "Browser family for launch_cdp. Default auto." },
        browserPath: { type: "string", description: "Advanced: explicit browser executable for launch_cdp." },
        allowCustomBrowserPath: { type: "boolean", description: "Allow browserPath outside known browser locations. Use only when intentional." },
        port: { type: "integer", minimum: 1024, maximum: 65535, description: "CDP port for launch_cdp. Default chooses 9222 if free, otherwise the next free local port." },
        profileName: { type: "string", description: "Name for a plugin-managed persistent profile under .browser-navigator/profiles. Default default." },
        userDataDir: { type: "string", description: "Advanced: explicit browser user data directory. Must pass allowExternalProfile:true when outside the project." },
        allowExternalProfile: { type: "boolean", description: "Allow explicit userDataDir outside the project root. Use only when intentional." },
        storageStatePath: { type: "string", description: "Project-relative storage state file. Default .browser-navigator/storage/<name>.json." },
        name: { type: "string", description: "Short name for save_storage default filename." },
        endpointURL: { type: "string", description: "CDP endpoint URL, usually http://127.0.0.1:9222. Default http://127.0.0.1:9222." },
        allowRemoteEndpoint: { type: "boolean", description: "Allow non-localhost CDP endpoint. Default false." },
        url: { type: "string", description: "Optional URL to open after connecting/loading profile/storage." },
        visible: { type: "boolean", description: "For use_profile/load_storage browser launch. Default true." },
        startupTimeoutMs: { type: "integer", minimum: 1000, maximum: 60000, description: "How long launch_cdp waits for the debug endpoint. Default 15000." },
        width: { type: "integer", minimum: 320, maximum: 3840 },
        height: { type: "integer", minimum: 240, maximum: 2160 },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "browser_switch_page",
    description: "Switch the active browser tab/page by ref, index, title, URL substring, or latest page, then return its view.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Page ref from browser_pages, such as p2." },
        index: { type: "integer", minimum: 1, description: "1-based page index from browser_pages." },
        latest: { type: "boolean", description: "Switch to the newest open page/tab." },
        titleContains: { type: "string", description: "Switch to the first page whose title contains this text." },
        urlContains: { type: "string", description: "Switch to the first page whose URL contains this text." },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_click",
    description: "Click a visible element by ref from browser_view, by visible text, or by CSS selector. Automatically switches to a new tab/page when the click opens one.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref number from browser_view." },
        text: { type: "string", description: "Visible text to click if ref is unavailable." },
        selector: { type: "string", description: "CSS selector to click." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 },
        switchToNewPage: { type: "boolean", description: "When true, select a newly opened tab/page after clicking. Default true." },
        newPageTimeoutMs: { type: "integer", minimum: 100, maximum: 10000, description: "How long to watch for a new tab/page after clicking. Default 1500." },
        expectDownload: { type: "boolean", description: "When true, capture a file download triggered by this click." },
        downloadName: { type: "string", description: "Optional saved filename for a captured download." },
        downloadTimeoutMs: { type: "integer", minimum: 500, maximum: 60000, description: "Download wait timeout. Default 15000." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_hover",
    description: "Hover a visible element by ref, text, or CSS selector, then return the updated page view. Useful for menus that open on hover.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref from browser_view/browser_find." },
        text: { type: "string", description: "Visible text to hover if ref is unavailable." },
        selector: { type: "string", description: "CSS selector to hover." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_type",
    description: "Fill or type text into an input/textarea/contenteditable element by ref, label text, placeholder text, or CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Input ref from browser_view." },
        text: { type: "string", description: "Text to enter." },
        selector: { type: "string", description: "CSS selector." },
        label: { type: "string", description: "Associated label text." },
        placeholder: { type: "string", description: "Input placeholder text." },
        submit: { type: "boolean", description: "Press Enter after typing." },
        append: { type: "boolean", description: "Append by typing instead of replacing existing value." }
      },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "browser_upload",
    description: "Upload one or more local files through a file input located by ref, selector, or label.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "File input ref from browser_view." },
        selector: { type: "string", description: "CSS selector for the file input." },
        label: { type: "string", description: "Associated label text for the file input." },
        paths: { type: "array", items: { type: "string" }, minItems: 1, description: "Local file paths. Relative paths are resolved from the project root; absolute paths are allowed when explicit." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 }
      },
      required: ["paths"],
      additionalProperties: false
    }
  },
  {
    name: "browser_dialog",
    description: "Arm handling for the next alert/confirm/prompt and report the most recent dialog. Unexpected dialogs are dismissed to avoid blocking the page.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "dismiss"], description: "How to handle the next dialog. Omit to only read the last dialog." },
        promptText: { type: "string", description: "Text to provide when accepting a prompt dialog." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_select",
    description: "Select an option in a native select element by ref, selector, or label. Use value, optionLabel, or index to choose the option.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Select ref from browser_view." },
        selector: { type: "string", description: "CSS selector for the select element." },
        targetLabel: { type: "string", description: "Associated label text for the select element." },
        value: { type: "string", description: "Option value to select." },
        optionLabel: { type: "string", description: "Visible option label to select." },
        index: { type: "integer", minimum: 0, description: "Zero-based option index." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_press",
    description: "Press a keyboard key such as Enter, Escape, Tab, ArrowDown, or Ctrl+L.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Playwright key name or shortcut." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 }
      },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "browser_scroll",
    description: "Scroll the page or a scrollable element by direction, pixels, top, bottom, or selector/ref. Returns the updated page view.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right", "top", "bottom"], description: "Default down." },
        pixels: { type: "integer", minimum: 1, maximum: 10000, description: "Scroll amount. Defaults to about one viewport." },
        ref: { type: "string", description: "Optional element ref from browser_view to scroll." },
        selector: { type: "string", description: "Optional CSS selector for a scrollable element." },
        waitMs: { type: "integer", minimum: 0, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_wait",
    description: "Wait for text, selector, URL substring, or a fixed delay.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        urlContains: { type: "string" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
        delayMs: { type: "integer", minimum: 0, maximum: 60000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_assert",
    description: "Check current page state and return PASS or an assertion error for text, selector, URL, or title conditions. Use for lightweight web QA.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text expected on the page." },
        selector: { type: "string", description: "CSS selector expected on the page." },
        urlContains: { type: "string", description: "Substring expected in current URL." },
        titleContains: { type: "string", description: "Substring expected in page title." },
        exact: { type: "boolean", description: "Exact text match for text condition. Default false." },
        visible: { type: "boolean", description: "Selector must be visible. Default true." },
        negate: { type: "boolean", description: "Assert the condition is absent/false instead of present/true. Default false." },
        timeoutMs: { type: "integer", minimum: 0, maximum: 60000, description: "Wait up to this long for the condition. Default 2000." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_back",
    description: "Navigate back in browser history and return the new page view.",
    inputSchema: {
      type: "object",
      properties: {
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_reload",
    description: "Reload the current page and return the new page view.",
    inputSchema: {
      type: "object",
      properties: {
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Navigation wait strategy. Default domcontentloaded." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_screenshot",
    description: "Save a screenshot under .browser-navigator/screenshots and return its path.",
    inputSchema: {
      type: "object",
      properties: {
        fullPage: { type: "boolean" },
        ref: { type: "string", description: "Optional element ref from browser_view for element screenshot." },
        selector: { type: "string", description: "Optional CSS selector for element screenshot." },
        name: { type: "string", description: "Optional filename without path." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_security_snapshot",
    description: "Return a compact defensive security snapshot for the current page: readable security headers, cookie flags, forms, mixed content, cross-origin resources, iframes, storage keys, and recent XHR/fetch status. Does not run exploit payloads.",
    inputSchema: {
      type: "object",
      properties: {
        maxItems: { type: "integer", minimum: 3, maximum: 50, description: "Maximum forms/resources/cookies/network rows to include. Default 12." }
      },
      additionalProperties: false
    }
  },
  {
    name: "browser_close",
    description: "Close the current browser session.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

function loadPlaywright() {
  if (state.playwright) return state.playwright;

  const candidates = [
    "playwright",
    path.join(__dirname, "node_modules", "playwright"),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", "playwright")
  ];

  const errors = [];
  for (const candidate of candidates) {
    try {
      state.playwright = require(candidate);
      return state.playwright;
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`Playwright is not available. Tried:\n${errors.join("\n")}`);
}

function writeProtocol(message) {
  const json = JSON.stringify(message);
  if (process.env.BROWSER_NAVIGATOR_JSONL === "1") {
    process.stdout.write(json + "\n");
    return;
  }
  const bytes = Buffer.byteLength(json, "utf8");
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function ok(id, result) {
  writeProtocol({ jsonrpc: "2.0", id, result });
}

function errorResponse(id, code, message) {
  writeProtocol({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(id, text, isError = false) {
  ok(id, { content: [{ type: "text", text }], isError });
}

function intArg(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function projectPath(input) {
  const resolved = path.resolve(ROOT, String(input));
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside project root: ${input}`);
  }
  return resolved;
}

function safeFileName(value, fallback = "default") {
  const name = String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
  return name || fallback;
}

function pluginDataPath(...parts) {
  const dir = path.join(ROOT, ".browser-navigator", ...parts);
  const relative = path.relative(ROOT, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Resolved plugin data path escaped project root.");
  return dir;
}

function explicitLocalPath(input) {
  const value = String(input || "");
  if (!value.trim()) throw new Error("path is required");
  const resolved = path.isAbsolute(value) ? path.resolve(value) : projectPath(value);
  if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${input}`);
  return resolved;
}

function resolveStorageStatePath(args = {}, mustExist = false) {
  const name = safeFileName(args.name || "default", "default");
  const defaultPath = pluginDataPath("storage", `${name.endsWith(".json") ? name : `${name}.json`}`);
  const resolved = args.storageStatePath ? projectPath(args.storageStatePath) : defaultPath;
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("storageStatePath must stay inside the project root.");
  if (mustExist && !fs.existsSync(resolved)) throw new Error(`Storage state file does not exist: ${resolved}`);
  return resolved;
}

function resolveProfileDir(args = {}) {
  if (args.userDataDir) {
    const resolved = path.resolve(String(args.userDataDir));
    const relative = path.relative(ROOT, resolved);
    if ((relative.startsWith("..") || path.isAbsolute(relative)) && args.allowExternalProfile !== true) {
      throw new Error("userDataDir is outside the project root. Pass allowExternalProfile:true only when you intentionally want to use that profile.");
    }
    return resolved;
  }
  return pluginDataPath("profiles", safeFileName(args.profileName || "default", "default"));
}

function assertLocalCdpEndpoint(endpointURL, allowRemoteEndpoint) {
  let parsed;
  try {
    parsed = new URL(endpointURL);
  } catch {
    throw new Error(`Invalid endpointURL: ${endpointURL}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("CDP endpointURL must be http(s).");
  const host = parsed.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!local && allowRemoteEndpoint !== true) {
    throw new Error("Refusing non-local CDP endpoint by default. Pass allowRemoteEndpoint:true only for a trusted endpoint.");
  }
}

function cdpBaseUrlFromPort(port) {
  return `http://127.0.0.1:${port}`;
}

function resolveCdpProfileDir(args = {}) {
  if (args.userDataDir) return resolveProfileDir(args);
  return pluginDataPath("cdp-profiles", safeFileName(args.profileName || "cdp", "cdp"));
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    if (!item) continue;
    const resolved = path.resolve(String(item));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

function browserExecutableCandidates(kind = "auto") {
  const wanted = String(kind || "auto").toLowerCase();
  const home = os.homedir();
  const pf = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] || process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [];

  function addEdge() {
    if (process.env.EDGE_PATH) candidates.push(process.env.EDGE_PATH);
    candidates.push(
      path.join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/opt/microsoft/msedge/msedge"
    );
  }

  function addChrome() {
    if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
    candidates.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pfx86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }

  if (process.env.BROWSER_NAVIGATOR_BROWSER_PATH) candidates.push(process.env.BROWSER_NAVIGATOR_BROWSER_PATH);
  if (wanted === "edge") addEdge();
  else if (wanted === "chrome") addChrome();
  else {
    addEdge();
    addChrome();
  }
  return uniqueExistingPaths(candidates);
}

function resolveBrowserExecutable(args = {}) {
  if (args.browserPath) {
    const resolved = path.resolve(String(args.browserPath));
    if (!fs.existsSync(resolved)) throw new Error(`browserPath does not exist: ${args.browserPath}`);
    const known = new Set(browserExecutableCandidates("auto").map((item) => process.platform === "win32" ? item.toLowerCase() : item));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!known.has(key) && args.allowCustomBrowserPath !== true) {
      throw new Error("browserPath is not a known Chrome/Edge executable. Pass allowCustomBrowserPath:true only when you trust this executable.");
    }
    return resolved;
  }
  const candidates = browserExecutableCandidates(args.browser || "auto");
  if (!candidates.length) {
    throw new Error("Could not find Chrome or Edge. Set BROWSER_NAVIGATOR_BROWSER_PATH or pass browserPath.");
  }
  return candidates[0];
}

function browserNameFromPath(filePath) {
  const name = path.basename(String(filePath || "")).toLowerCase();
  if (name.includes("edge")) return "edge";
  if (name.includes("chrome")) return "chrome";
  if (name.includes("chromium")) return "chromium";
  return name || "browser";
}

function httpGetText(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1048576) req.destroy(new Error("response too large"));
      });
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout fetching ${url}`)));
  });
}

async function probeCdpEndpoint(endpointURL) {
  try {
    const versionUrl = new URL("/json/version", endpointURL).toString();
    const text = await httpGetText(versionUrl, 1200);
    const data = JSON.parse(text);
    return Boolean(data.webSocketDebuggerUrl || data.Browser || data["Protocol-Version"]);
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function chooseCdpPort(args = {}) {
  if (args.endpointURL) {
    const parsed = new URL(String(args.endpointURL));
    return intArg(parsed.port || 9222, 9222, 1024, 65535);
  }
  if (args.port !== undefined) return intArg(args.port, 9222, 1024, 65535);
  for (let port = 9222; port <= 9250; port += 1) {
    if (await probeCdpEndpoint(cdpBaseUrlFromPort(port))) return port;
    if (await isPortFree(port)) return port;
  }
  throw new Error("Could not find a free local CDP port between 9222 and 9250.");
}

async function waitForCdpEndpoint(endpointURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdpEndpoint(endpointURL)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`CDP endpoint did not become ready: ${endpointURL}`);
}

function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) throw new Error("url is required");
  if (/^(https?|file|data):/i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`;
  const local = projectPath(value);
  if (fs.existsSync(local)) return pathToFileURL(local).href;
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;
  return value;
}

function pushBounded(list, item, max = 80) {
  list.push({ time: new Date().toISOString(), ...item });
  while (list.length > max) list.shift();
}

function resetLogs() {
  state.consoleLogs = [];
  state.networkLogs = [];
  state.networkEntries = [];
  state.networkSeq = 0;
  state.pageErrors = [];
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

function recordDownload({ filePath, suggestedFilename, url, page }) {
  const info = fileInfo(filePath);
  const item = {
    id: `d${++state.downloadSeq}`,
    time: new Date().toISOString(),
    page: pageRef(page),
    suggestedFilename: suggestedFilename || path.basename(filePath),
    path: filePath,
    url: url || "",
    exists: info.exists,
    size: info.size
  };
  state.downloads.push(item);
  while (state.downloads.length > 80) state.downloads.shift();
  return item;
}

function formatDownload(item) {
  const info = fileInfo(item.path);
  item.exists = info.exists;
  item.size = info.size;
  const status = item.exists ? `${item.size} bytes` : "missing";
  return `[${item.id}] ${item.suggestedFilename || path.basename(item.path)} | ${status} | ${item.path}${item.url ? ` | ${item.url}` : ""}`;
}

function truncateText(value, maxChars = 8000) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function debugLog(message) {
  if (process.env.BROWSER_NAVIGATOR_DEBUG === "1") {
    process.stderr.write(`[browser-navigator] ${message}\n`);
  }
}

function redactHeaders(headers = {}) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token)$/i.test(name)) {
      redacted[name] = "<redacted>";
    } else {
      redacted[name] = value;
    }
  }
  return redacted;
}

function headerValue(headers = {}, target) {
  const wanted = String(target).toLowerCase();
  for (const [name, value] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() === wanted) return String(value || "");
  }
  return "";
}

function shouldCaptureResponseBody(headers = {}) {
  const disposition = headerValue(headers, "content-disposition").toLowerCase();
  if (disposition.includes("attachment")) return false;
  const type = headerValue(headers, "content-type").toLowerCase();
  if (!type) return false;
  return (
    type.includes("json") ||
    type.startsWith("text/") ||
    type.includes("xml") ||
    type.includes("javascript") ||
    type.includes("x-www-form-urlencoded")
  );
}

function pushNetworkEntry(entry) {
  const item = {
    id: `n${++state.networkSeq}`,
    time: new Date().toISOString(),
    ...entry
  };
  state.networkEntries.push(item);
  while (state.networkEntries.length > 120) state.networkEntries.shift();
  return item;
}

function captureRequest(page, request) {
  const resourceType = request.resourceType();
  if (!TRACKED_NETWORK_TYPES.has(resourceType)) return;
  const entry = pushNetworkEntry({
    page: pageRef(page),
    resourceType,
    method: request.method(),
    url: request.url(),
    status: "pending",
    ok: false,
    requestHeaders: redactHeaders(request.headers()),
    requestBodyPreview: truncateText(request.postData() || "", 8000)
  });
  requestEntries.set(request, entry);
}

async function captureResponse(page, response) {
  const request = response.request();
  const status = response.status();
  const entry = requestEntries.get(request);
  if (entry) {
    const responseHeaders = redactHeaders(response.headers());
    entry.status = status;
    entry.ok = status >= 200 && status < 400;
    entry.responseHeaders = responseHeaders;
    entry.contentType = headerValue(responseHeaders, "content-type");
    try {
      const contentLength = Number.parseInt(headerValue(responseHeaders, "content-length"), 10);
      const smallEnough = !Number.isFinite(contentLength) || contentLength <= 512000;
      if (smallEnough && shouldCaptureResponseBody(responseHeaders)) {
        entry.responseBodyPreview = truncateText(await response.text(), 20000);
      }
    } catch (error) {
      entry.responseBodyError = error.message;
    }
  }
  if (status >= 400) {
    pushBounded(state.networkLogs, {
      page: pageRef(page),
      type: "response",
      status,
      url: response.url()
    });
  }
}

function captureRequestFailure(page, request) {
  const failure = request.failure() ? request.failure().errorText : "unknown";
  const entry = requestEntries.get(request);
  if (entry) {
    entry.status = "failed";
    entry.ok = false;
    entry.failure = failure;
  }
  pushBounded(state.networkLogs, {
    page: pageRef(page),
    type: "requestfailed",
    method: request.method(),
    url: request.url(),
    failure
  });
}

function attachPageEvents(page) {
  if (pageEventsAttached.has(page)) return;
  pageEventsAttached.add(page);
  page.on("close", () => {
    state.pages = state.pages.filter((candidate) => candidate !== page);
    if (state.page === page) {
      state.page = currentPages()[0] || null;
    }
  });
  page.on("console", (msg) => {
    const type = msg.type();
    pushBounded(state.consoleLogs, { page: pageRef(page), type, text: msg.text(), location: msg.location() }, 160);
  });
  page.on("pageerror", (error) => {
    pushBounded(state.pageErrors, { page: pageRef(page), message: error.message, stack: error.stack || "" });
  });
  page.on("request", (request) => captureRequest(page, request));
  page.on("requestfailed", (request) => captureRequestFailure(page, request));
  page.on("response", (response) => {
    captureResponse(page, response).catch((error) => {
      pushBounded(state.networkLogs, { page: pageRef(page), type: "network-capture-error", message: error.message });
    });
  });
  page.on("dialog", async (dialog) => {
    const policy = state.dialogPolicy || { action: "dismiss" };
    const action = policy.action === "accept" ? "accept" : "dismiss";
    const item = {
      time: new Date().toISOString(),
      page: pageRef(page),
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
      action,
      promptText: policy.promptText || "",
      error: ""
    };
    try {
      if (action === "accept") await dialog.accept(policy.promptText || "");
      else await dialog.dismiss();
    } catch (error) {
      item.error = error.message;
    } finally {
      state.lastDialog = item;
      state.dialogPolicy = null;
    }
  });
}

function pageRef(page) {
  if (!page) return "";
  let ref = pageRefs.get(page);
  if (!ref) {
    ref = `p${++state.pageSeq}`;
    pageRefs.set(page, ref);
  }
  return ref;
}

function registerPage(page) {
  if (!page || page.isClosed()) return null;
  const ref = pageRef(page);
  if (!state.pages.includes(page)) state.pages.push(page);
  attachPageEvents(page);
  return ref;
}

function currentPages() {
  if (state.context) {
    for (const page of state.context.pages()) registerPage(page);
  }
  state.pages = state.pages.filter((page) => page && !page.isClosed());
  return state.pages.slice();
}

function setCurrentPage(page) {
  if (!page || page.isClosed()) return null;
  registerPage(page);
  state.page = page;
  return page;
}

function attachContextEvents(context) {
  if (!context || state.contextEventsAttached) return;
  state.contextEventsAttached = true;
  context.on("page", async (page) => {
    setCurrentPage(page);
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    } catch {
      // A page may be blank, blocked, or still loading. It is still selectable.
    }
  });
}

async function launchIfNeeded(args = {}) {
  const visible = args.visible === undefined ? state.visible : Boolean(args.visible);
  const width = intArg(args.width, state.viewport.width, 320, 3840);
  const height = intArg(args.height, state.viewport.height, 240, 2160);
  const needsNewBrowser = !state.context || (!["persistent", "cdp"].includes(state.browserKind) && visible !== state.visible);
  state.visible = visible;
  state.viewport = { width, height };

  if (needsNewBrowser) {
    await closeBrowser();
    const { chromium } = loadPlaywright();
    const launchOptions = {
      headless: !visible,
      args: ["--disable-dev-shm-usage", "--disable-popup-blocking"]
    };
    const attempts = [
      () => chromium.launch(launchOptions),
      () => chromium.launch({ ...launchOptions, channel: "msedge" }),
      () => chromium.launch({ ...launchOptions, channel: "chrome" })
    ];
    const errors = [];
    for (const attempt of attempts) {
      try {
        state.browser = await attempt();
        state.browserKind = "launched";
        break;
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (!state.browser) throw new Error(`Could not launch browser:\n${errors.join("\n\n")}`);
  }

  if (!state.context) {
    state.context = await state.browser.newContext({
      viewport: state.viewport,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      storageState: args.storageStatePath || undefined
    });
    attachContextEvents(state.context);
  }
  if (!state.page || state.page.isClosed()) {
    setCurrentPage(await state.context.newPage());
  }
  return state.page;
}

async function closeBrowser(options = {}) {
  if (state.browserKind === "persistent" && state.context) {
    try {
      await Promise.race([
        state.context.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("persistent context close timed out")), 10000))
      ]);
    } catch {
      // Ignore close errors.
    }
  } else if (state.browserKind === "cdp" && state.browser) {
    try {
      if (options.closeLaunchedCdp && state.cdpLaunchedByPlugin) await state.browser.close();
      else if (typeof state.browser.disconnect === "function") state.browser.disconnect();
      else await state.browser.close();
    } catch {
      // Ignore disconnect errors.
    }
  } else if (state.browser) {
    try {
      await Promise.race([
        state.browser.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close timed out")), 10000))
      ]);
    } catch {
      // Ignore close errors.
    }
  }
  if (options.closeLaunchedCdp && state.cdpLaunchedByPlugin && state.cdpProcess && !state.cdpProcess.killed) {
    try {
      state.cdpProcess.kill();
    } catch {
      // Ignore process cleanup errors.
    }
  }
  state.browser = null;
  state.context = null;
  state.page = null;
  state.pages = [];
  state.contextEventsAttached = false;
  state.pageSeq = 0;
  state.browserKind = "none";
  state.profileDir = "";
  state.storageStatePath = "";
  state.cdpEndpoint = "";
  state.cdpProcess = null;
  state.cdpLaunchedByPlugin = false;
  state.cdpLaunchInfo = null;
  resetLogs();
}

function requirePage() {
  if (!state.page || state.page.isClosed()) state.page = currentPages()[0] || null;
  if (!state.page) throw new Error("No browser page is open. Call browser_open first.");
  return state.page;
}

async function pageView(args = {}) {
  const page = requirePage();
  registerPage(page);
  const pages = currentPages();
  const maxTextLines = intArg(args.maxTextLines, 80, 10, 300);
  const maxElements = intArg(args.maxElements, 80, 10, 300);
  const data = await page.evaluate(({ refAttr, maxTextLines, maxElements }) => {
    const interactiveSelector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[onclick]",
      "[contenteditable='true']"
    ].join(",");

    function isVisible(element) {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
      return true;
    }

    function ownText(element) {
      const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    }

    function labelFor(element) {
      const labels = [];
      if (element.getAttribute("aria-label")) labels.push(element.getAttribute("aria-label"));
      if (element.getAttribute("title")) labels.push(element.getAttribute("title"));
      if (element.getAttribute("placeholder")) labels.push(element.getAttribute("placeholder"));
      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) labels.push(label.innerText || label.textContent || "");
      }
      const text = ownText(element);
      if (text) labels.push(text);
      if (element.tagName === "IMG" && element.getAttribute("alt")) labels.push(element.getAttribute("alt"));
      if (element.tagName === "A" && element.getAttribute("href")) labels.push(element.getAttribute("href"));
      return labels.map((value) => String(value).replace(/\s+/g, " ").trim()).filter(Boolean)[0] || element.tagName.toLowerCase();
    }

    const allLines = (document.body ? document.body.innerText : "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const textTotal = allLines.length;
    // Cap each line so one giant paragraph cannot dominate the token budget.
    const bodyText = allLines
      .slice(0, maxTextLines)
      .map((line) => (line.length > 200 ? `${line.slice(0, 197)}...` : line));

    const allInteractive = Array.from(document.querySelectorAll(interactiveSelector)).filter(isVisible);
    const interactiveTotal = allInteractive.length;
    const interactive = [];
    document.querySelectorAll(`[${refAttr}]`).forEach((element) => element.removeAttribute(refAttr));
    for (const element of allInteractive) {
      if (interactive.length >= maxElements) break;
      const ref = String(interactive.length + 1);
      element.setAttribute(refAttr, ref);
      const rect = element.getBoundingClientRect();
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || "";
      const type = element.getAttribute("type") || "";
      const href = tag === "a" ? element.href : "";
      const disabled = Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
      interactive.push({
        ref,
        tag,
        role,
        type,
        label: labelFor(element),
        href,
        disabled,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      });
    }

    let focused = null;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      let ref = active.getAttribute(refAttr);
      if (!ref && isVisible(active)) {
        ref = `focused-${Date.now()}`;
        active.setAttribute(refAttr, ref);
      }
      const rect = active.getBoundingClientRect();
      focused = {
        ref,
        tag: active.tagName ? active.tagName.toLowerCase() : "",
        role: active.getAttribute ? active.getAttribute("role") || "" : "",
        type: active.getAttribute ? active.getAttribute("type") || "" : "",
        label: active instanceof Element ? labelFor(active) : "",
        box: active instanceof Element ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        } : null
      };
    }

    return {
      url: location.href,
      title: document.title || "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
        maxX: Math.max(0, Math.round(document.documentElement.scrollWidth - window.innerWidth)),
        maxY: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight))
      },
      focused,
      text: bodyText,
      textTotal,
      interactive,
      interactiveTotal
    };
  }, { refAttr: REF_ATTR, maxTextLines, maxElements });

  const clickables = data.interactive.filter((item) => !["input", "textarea", "select"].includes(item.tag));
  const inputs = data.interactive.filter((item) => ["input", "textarea", "select"].includes(item.tag));
  const pageIndex = Math.max(1, pages.indexOf(page) + 1);
  // Surface what was dropped so the model knows there is more and how to get it,
  // instead of silently believing the capped view is the whole page.
  const moreText = (data.textTotal || data.text.length) - data.text.length;
  const moreInteractive = (data.interactiveTotal || data.interactive.length) - data.interactive.length;

  const lines = [
    `Tab: ${pageRef(page)} (${pageIndex} of ${pages.length || 1})`,
    `URL: ${data.url}`,
    `Title: ${data.title || "(no title)"}`,
    `Viewport: ${data.viewport.width}x${data.viewport.height}`,
    `Scroll: x=${data.scroll.x}/${data.scroll.maxX} y=${data.scroll.y}/${data.scroll.maxY}`,
    `Focused: ${data.focused ? formatElement(data.focused) : "(none)"}`,
    "",
    "Visible text:",
    ...(data.text.length ? data.text.map((line, index) => `${index + 1}. ${line}`) : ["(none)"]),
    ...(moreText > 0 ? [`...(+${moreText} more text lines not shown; scroll down or raise maxTextLines)`] : []),
    "",
    "Clickable:",
    ...(clickables.length ? clickables.map(formatElement) : ["(none)"]),
    "",
    "Inputs:",
    ...(inputs.length ? inputs.map(formatElement) : ["(none)"]),
    ...(moreInteractive > 0 ? [`...(+${moreInteractive} more interactive elements not shown; scroll or raise maxElements)`] : []),
    "",
    "Recent console/page errors:",
    ...formatLogs([
      ...state.consoleLogs.filter((item) => ["error", "warning", "assert"].includes(String(item.type).toLowerCase())).slice(-10),
      ...state.pageErrors.slice(-5)
    ]),
    "",
    "Recent network issues:",
    ...formatLogs(state.networkLogs.slice(-10))
  ];
  return lines.join("\n");
}

function formatElement(item) {
  const type = item.type ? ` type=${item.type}` : "";
  const role = item.role ? ` role=${item.role}` : "";
  const href = item.href ? ` href=${item.href}` : "";
  const disabled = item.disabled ? " disabled" : "";
  return `[${item.ref}] ${item.tag}${type}${role}${disabled} "${item.label}" box=${item.box.x},${item.box.y},${item.box.w},${item.box.h}${href}`;
}

function formatLogs(logs) {
  if (!logs.length) return ["(none)"];
  return logs.map((item, index) => {
    const bits = [];
    if (item.type) bits.push(item.type);
    if (item.page) bits.push(item.page);
    if (item.status) bits.push(String(item.status));
    if (item.method) bits.push(item.method);
    if (item.url) bits.push(item.url);
    if (item.text) bits.push(item.text);
    if (item.message) bits.push(item.message);
    if (item.failure) bits.push(item.failure);
    return `${index + 1}. ${bits.join(" | ")}`;
  });
}

async function browserOpen(args = {}) {
  const page = await launchIfNeeded(args);
  setCurrentPage(page);
  const url = normalizeUrl(args.url);
  const waitUntil = args.waitUntil || "domcontentloaded";
  await page.goto(url, { waitUntil, timeout: 45000 });
  return pageView({});
}

async function browserPages() {
  const pages = currentPages();
  if (!pages.length) return "No browser pages are open.";
  const lines = ["Open tabs/pages:"];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const title = await safePageTitle(page);
    const active = page === state.page ? ">" : " ";
    lines.push(`${active} ${index + 1}. [${pageRef(page)}] ${title || "(no title)"} | ${page.url()}`);
  }
  return lines.join("\n");
}

async function attachCdpEndpoint(endpointURL, launchInfo = null) {
  const { chromium } = loadPlaywright();
  state.browser = await chromium.connectOverCDP(endpointURL);
  state.browserKind = "cdp";
  state.cdpEndpoint = endpointURL;
  state.contextEventsAttached = false;
  state.cdpLaunchedByPlugin = Boolean(launchInfo);
  state.cdpProcess = launchInfo ? launchInfo.process : null;
  state.cdpLaunchInfo = launchInfo ? {
    browser: launchInfo.browser,
    browserPath: launchInfo.browserPath,
    port: launchInfo.port,
    userDataDir: launchInfo.userDataDir,
    pid: launchInfo.process && launchInfo.process.pid ? launchInfo.process.pid : null,
    startedAt: launchInfo.startedAt
  } : null;
  if (launchInfo && launchInfo.userDataDir) state.profileDir = launchInfo.userDataDir;
  const contexts = state.browser.contexts();
  state.context = contexts[0] || await state.browser.newContext({ viewport: state.viewport, ignoreHTTPSErrors: true, acceptDownloads: true });
  attachContextEvents(state.context);
  const pages = state.context.pages();
  setCurrentPage(pages.find((page) => !page.isClosed()) || await state.context.newPage());
}

async function browserSession(args = {}) {
  const action = String(args.action || "status");

  async function maybeOpenAfterConnect(prefix) {
    if (args.url) {
      const page = requirePage();
      await page.goto(normalizeUrl(args.url), { waitUntil: args.waitUntil || "domcontentloaded", timeout: 45000 });
      return `${prefix}\n\n${await pageView({})}`;
    }
    return `${prefix}\n\n${await browserSession({ action: "status" })}`;
  }

  if (action === "status") {
    const pages = currentPages();
    let cookies = 0;
    try {
      if (state.context && state.page && !state.page.isClosed()) cookies = (await state.context.cookies([state.page.url()])).length;
    } catch {
      cookies = 0;
    }
    return [
      `Browser session: ${state.browserKind}`,
      `Active page: ${state.page && !state.page.isClosed() ? `${pageRef(state.page)} ${state.page.url()}` : "(none)"}`,
      `Pages: ${pages.length}`,
      `Visible: ${state.visible}`,
      `Viewport: ${state.viewport.width}x${state.viewport.height}`,
      `Profile dir: ${state.profileDir || "(none)"}`,
      `Storage state path: ${state.storageStatePath || "(none)"}`,
      `CDP endpoint: ${state.cdpEndpoint || "(none)"}`,
      `CDP launched by plugin: ${state.cdpLaunchedByPlugin ? "yes" : "no"}`,
      state.cdpLaunchInfo ? `CDP launch: ${state.cdpLaunchInfo.browser} pid=${state.cdpLaunchInfo.pid || "(unknown)"} profile=${state.cdpLaunchInfo.userDataDir}` : "",
      `Cookies visible to current page: ${cookies}`,
      "",
      "Notes:",
      "- save_storage writes cookies/localStorage to a project file; treat it as sensitive.",
      "- launch_cdp starts an isolated debug browser and connects automatically.",
      "- connect_cdp attaches to an existing browser debugging endpoint; localhost is required unless allowRemoteEndpoint:true."
    ].filter((line) => line !== "").join("\n");
  }

  if (action === "disconnect") {
    await closeBrowser();
    return "Browser session disconnected/closed.";
  }

  if (action === "save_storage") {
    const page = requirePage();
    if (!state.context) throw new Error("No browser context is open.");
    const filePath = resolveStorageStatePath(args, false);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await state.context.storageState({ path: filePath });
    state.storageStatePath = filePath;
    return [
      `Saved browser storage state: ${filePath}`,
      `Current page: ${page.url()}`,
      "Sensitive: this file may contain cookies, localStorage, and session tokens. Do not commit it."
    ].join("\n");
  }

  if (action === "load_storage") {
    const filePath = resolveStorageStatePath(args, true);
    const visible = args.visible === undefined ? state.visible : Boolean(args.visible);
    const width = intArg(args.width, state.viewport.width, 320, 3840);
    const height = intArg(args.height, state.viewport.height, 240, 2160);
    await closeBrowser();
    state.visible = visible;
    state.viewport = { width, height };
    await launchIfNeeded({ visible, width, height, storageStatePath: filePath });
    state.storageStatePath = filePath;
    state.browserKind = "launched-storage";
    return maybeOpenAfterConnect(`Loaded browser storage state: ${filePath}`);
  }

  if (action === "use_profile") {
    const visible = args.visible === undefined ? true : Boolean(args.visible);
    const width = intArg(args.width, state.viewport.width, 320, 3840);
    const height = intArg(args.height, state.viewport.height, 240, 2160);
    const userDataDir = resolveProfileDir(args);
    fs.mkdirSync(userDataDir, { recursive: true });
    await closeBrowser();
    const { chromium } = loadPlaywright();
    state.visible = visible;
    state.viewport = { width, height };
    state.context = await chromium.launchPersistentContext(userDataDir, {
      headless: !visible,
      viewport: state.viewport,
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      args: ["--disable-dev-shm-usage", "--disable-popup-blocking"]
    });
    state.browser = state.context.browser();
    state.browserKind = "persistent";
    state.profileDir = userDataDir;
    state.contextEventsAttached = false;
    attachContextEvents(state.context);
    const pages = state.context.pages();
    setCurrentPage(pages[0] || await state.context.newPage());
    return maybeOpenAfterConnect(`Using persistent browser profile: ${userDataDir}`);
  }

  if (action === "launch_cdp") {
    const visible = args.visible === undefined ? true : Boolean(args.visible);
    const width = intArg(args.width, state.viewport.width, 320, 3840);
    const height = intArg(args.height, state.viewport.height, 240, 2160);
    const port = await chooseCdpPort(args);
    const endpointURL = args.endpointURL ? String(args.endpointURL).trim() : cdpBaseUrlFromPort(port);
    assertLocalCdpEndpoint(endpointURL, args.allowRemoteEndpoint);
    const readyAlready = await probeCdpEndpoint(endpointURL);
    await closeBrowser();
    state.visible = visible;
    state.viewport = { width, height };

    if (readyAlready) {
      await attachCdpEndpoint(endpointURL, null);
      return maybeOpenAfterConnect(`Connected to existing CDP endpoint already listening: ${endpointURL}`);
    }

    if (args.port !== undefined && !(await isPortFree(port))) {
      throw new Error(`Port ${port} is occupied but does not look like a Chrome/Edge CDP endpoint. Choose another port or close the process using it.`);
    }

    const browserPath = resolveBrowserExecutable(args);
    const browser = browserNameFromPath(browserPath);
    const userDataDir = resolveCdpProfileDir(args);
    fs.mkdirSync(userDataDir, { recursive: true });
    const launchArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      `--window-size=${width},${height}`
    ];
    if (!visible) {
      launchArgs.push("--headless=new", "--disable-gpu");
    }
    launchArgs.push("about:blank");
    const child = spawn(browserPath, launchArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: !visible
    });
    child.unref();
    const startupTimeoutMs = intArg(args.startupTimeoutMs, 15000, 1000, 60000);
    await waitForCdpEndpoint(endpointURL, startupTimeoutMs);
    await attachCdpEndpoint(endpointURL, {
      process: child,
      browser,
      browserPath,
      port,
      userDataDir,
      startedAt: new Date().toISOString()
    });
    return maybeOpenAfterConnect(`Launched ${browser} with CDP and connected: ${endpointURL}\nProfile dir: ${userDataDir}`);
  }

  if (action === "connect_cdp") {
    const endpointURL = String(args.endpointURL || "http://127.0.0.1:9222").trim();
    assertLocalCdpEndpoint(endpointURL, args.allowRemoteEndpoint);
    if (!(await probeCdpEndpoint(endpointURL))) {
      throw new Error(`No Chrome/Edge CDP endpoint is listening at ${endpointURL}. Use browser_session { "action": "launch_cdp" } to let this plugin start an isolated debug browser automatically, or start your browser with --remote-debugging-port first.`);
    }
    await closeBrowser();
    await attachCdpEndpoint(endpointURL, null);
    return maybeOpenAfterConnect(`Connected to CDP endpoint: ${endpointURL}`);
  }

  throw new Error(`Unknown browser_session action: ${action}`);
}

async function browserFind(args = {}) {
  const page = requirePage();
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query is required");
  const maxMatches = intArg(args.maxMatches, 12, 1, 80);
  const contextChars = intArg(args.contextChars, 160, 20, 1000);
  const data = await page.evaluate(({ refAttr, query, matchCase, selector, maxMatches, contextChars, includeInputs }) => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { url: location.href, title: document.title || "", total: 0, matches: [], error: `selector not found: ${selector}` };
    const needle = matchCase ? query : query.toLowerCase();
    const candidates = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "label",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='menuitem']",
      "[onclick]",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "li",
      "td",
      "th",
      "caption",
      "dt",
      "dd",
      "blockquote",
      "code",
      "pre"
    ].join(",");

    function isVisible(element) {
      if (!element || !(element instanceof Element)) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }

    function elementText(element) {
      const values = [];
      if (includeInputs && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
        values.push(element.value, element.getAttribute("placeholder"), element.getAttribute("aria-label"));
        if (element.tagName === "SELECT") {
          const selected = element.selectedOptions && element.selectedOptions[0];
          if (selected) values.push(selected.textContent);
        }
      }
      values.push(element.innerText, element.textContent, element.getAttribute("title"), element.getAttribute("alt"));
      return values.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }

    function snippet(text, index) {
      const start = Math.max(0, index - Math.floor(contextChars / 2));
      const end = Math.min(text.length, index + needle.length + Math.ceil(contextChars / 2));
      return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
    }

    const elements = Array.from(root.querySelectorAll(candidates)).filter(isVisible);
    const all = [];
    const seen = new Set();
    for (const element of elements) {
      const raw = elementText(element);
      if (!raw) continue;
      const haystack = matchCase ? raw : raw.toLowerCase();
      const index = haystack.indexOf(needle);
      if (index === -1) continue;
      const key = `${element.tagName}:${raw.slice(0, 160)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = `find-${all.length + 1}`;
      element.setAttribute(refAttr, ref);
      const rect = element.getBoundingClientRect();
      all.push({
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        text: snippet(raw, index),
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      });
    }
    return {
      url: location.href,
      title: document.title || "",
      total: all.length,
      matches: all.slice(0, maxMatches),
      error: ""
    };
  }, {
    refAttr: REF_ATTR,
    query,
    matchCase: Boolean(args.matchCase),
    selector: args.selector ? String(args.selector) : "",
    maxMatches,
    contextChars,
    includeInputs: args.includeInputs !== false
  });
  const lines = [
    `Find: ${query}`,
    `URL: ${data.url}`,
    `Title: ${data.title || "(no title)"}`,
    data.error ? `Error: ${data.error}` : `Matches: ${data.matches.length} shown of ${data.total}`,
    ""
  ];
  if (data.matches.length) {
    for (const item of data.matches) {
      const role = item.role ? ` role=${item.role}` : "";
      const type = item.type ? ` type=${item.type}` : "";
      lines.push(`[${item.ref}] ${item.tag}${type}${role} box=${item.box.x},${item.box.y},${item.box.w},${item.box.h} "${item.text}"`);
    }
  } else {
    lines.push("(no matches)");
  }
  if (data.total > data.matches.length) lines.push(`...(+${data.total - data.matches.length} more; raise maxMatches or narrow selector)`);
  return lines.join("\n");
}

function markdownCell(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function formatTableSource(source = {}) {
  const parts = [];
  if (source.index !== undefined) parts.push(`index=${source.index}`);
  if (source.tag) parts.push(`tag=${source.tag}`);
  if (source.box) parts.push(`box=${source.box.x},${source.box.y},${source.box.w},${source.box.h}`);
  return parts.join(" ") || "(unknown)";
}

function formatExtractedTable(data, format) {
  if (format === "json") return JSON.stringify(data, null, 2);
  const cols = Math.max(data.headers.length, ...data.rows.map((row) => row.length), 1);
  const headers = Array.from({ length: cols }, (_, index) => markdownCell(data.headers[index] || `Column ${index + 1}`));
  const lines = [
    `Table: ${data.caption || "(no caption)"}`,
    `Source: ${formatTableSource(data.source)}`,
    `Rows: ${data.rows.length} shown of ${data.totalRows}, columns: ${cols}${data.truncated ? " (truncated)" : ""}`,
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of data.rows) {
    const cells = Array.from({ length: cols }, (_, index) => markdownCell(row[index] || ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function browserExtractTable(args = {}) {
  const page = requirePage();
  const maxRows = intArg(args.maxRows, 40, 1, 500);
  const maxCols = intArg(args.maxCols, 20, 1, 80);
  const maxCellChars = intArg(args.maxCellChars, 160, 20, 2000);
  const format = args.format === "json" ? "json" : "markdown";
  const extractor = (element, options) => {
    function isVisible(el) {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }
    function cellText(cell) {
      const text = (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
      return text.length <= options.maxCellChars ? text : `${text.slice(0, options.maxCellChars)}...`;
    }
    let table = element;
    if (table && table.tagName !== "TABLE") table = table.closest("table");
    if (!table || table.tagName !== "TABLE") throw new Error("Target is not inside a table.");
    if (!isVisible(table)) throw new Error("Target table is not visible.");
    const caption = table.caption ? cellText(table.caption) : "";
    const allRows = Array.from(table.rows || []);
    let headerRows = Array.from(table.tHead ? table.tHead.rows : []);
    if (!headerRows.length && allRows[0] && Array.from(allRows[0].cells || []).some((cell) => cell.tagName === "TH")) {
      headerRows = [allRows[0]];
    }
    const headerRowSet = new Set(headerRows);
    const headers = [];
    for (const row of headerRows.slice(0, 1)) {
      for (const cell of Array.from(row.cells || []).slice(0, options.maxCols)) headers.push(cellText(cell));
    }
    const bodyRows = allRows.filter((row) => !headerRowSet.has(row));
    const rows = bodyRows.slice(0, options.maxRows).map((row) => Array.from(row.cells || []).slice(0, options.maxCols).map(cellText));
    const rect = table.getBoundingClientRect();
    return {
      caption,
      headers,
      rows,
      totalRows: bodyRows.length,
      totalColumns: Math.max(headers.length, ...rows.map((row) => row.length), 0),
      truncated: bodyRows.length > rows.length || rows.some((row) => row.length >= options.maxCols),
      source: {
        tag: "table",
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      }
    };
  };
  let data;
  if (args.ref || args.selector) {
    const locator = await locatorFromArgs(page, args, false);
    data = await locator.evaluate(extractor, { maxRows, maxCols, maxCellChars });
  } else {
    const index = intArg(args.index, 0, 0, 10000);
    data = await page.evaluate(({ index, maxRows, maxCols, maxCellChars }) => {
      const tables = Array.from(document.querySelectorAll("table"));
      const visible = tables.filter((table) => {
        const style = window.getComputedStyle(table);
        const rect = table.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      });
      const table = visible[index];
      if (!table) throw new Error(`No visible table found at index ${index}. Visible tables: ${visible.length}`);
      const extractor = (element, options) => {
        function cellText(cell) {
          const text = (cell.innerText || cell.textContent || "").replace(/\s+/g, " ").trim();
          return text.length <= options.maxCellChars ? text : `${text.slice(0, options.maxCellChars)}...`;
        }
        const caption = element.caption ? cellText(element.caption) : "";
        const allRows = Array.from(element.rows || []);
        let headerRows = Array.from(element.tHead ? element.tHead.rows : []);
        if (!headerRows.length && allRows[0] && Array.from(allRows[0].cells || []).some((cell) => cell.tagName === "TH")) headerRows = [allRows[0]];
        const headerRowSet = new Set(headerRows);
        const headers = [];
        for (const row of headerRows.slice(0, 1)) {
          for (const cell of Array.from(row.cells || []).slice(0, options.maxCols)) headers.push(cellText(cell));
        }
        const bodyRows = allRows.filter((row) => !headerRowSet.has(row));
        const rows = bodyRows.slice(0, options.maxRows).map((row) => Array.from(row.cells || []).slice(0, options.maxCols).map(cellText));
        const rect = element.getBoundingClientRect();
        return {
          caption,
          headers,
          rows,
          totalRows: bodyRows.length,
          totalColumns: Math.max(headers.length, ...rows.map((row) => row.length), 0),
          truncated: bodyRows.length > rows.length || rows.some((row) => row.length >= options.maxCols),
          source: {
            index: options.index,
            tag: "table",
            box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
          }
        };
      };
      return extractor(table, { index, maxRows, maxCols, maxCellChars });
    }, { index, maxRows, maxCols, maxCellChars });
  }
  return formatExtractedTable(data, format);
}

async function browserExtractLinks(args = {}) {
  const page = requirePage();
  const maxItems = intArg(args.maxItems, 40, 1, 200);
  const data = await page.evaluate(({ refAttr, textContains, urlContains, sameOrigin, external, selector, includeHidden, maxItems }) => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { url: location.href, title: document.title || "", total: 0, links: [], error: `selector not found: ${selector}` };
    const textNeedle = textContains ? String(textContains).toLowerCase() : "";
    const urlNeedle = urlContains ? String(urlContains).toLowerCase() : "";

    function isVisible(element) {
      if (includeHidden) return true;
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }

    function clean(value, max = 180) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
    }

    const all = [];
    const seen = new Set();
    for (const anchor of Array.from(root.querySelectorAll("a[href]"))) {
      const href = anchor.href || "";
      if (!href || seen.has(href)) continue;
      const text = clean(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title") || href);
      if (textNeedle && !text.toLowerCase().includes(textNeedle)) continue;
      if (urlNeedle && !href.toLowerCase().includes(urlNeedle)) continue;
      let relation = "unknown";
      try {
        relation = new URL(href).origin === location.origin ? "same-origin" : "external";
      } catch {}
      if (sameOrigin && relation !== "same-origin") continue;
      if (external && relation !== "external") continue;
      if (!isVisible(anchor)) continue;
      seen.add(href);
      const ref = `link-${all.length + 1}`;
      anchor.setAttribute(refAttr, ref);
      const rect = anchor.getBoundingClientRect();
      all.push({
        ref,
        text,
        href,
        relation,
        target: anchor.getAttribute("target") || "",
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
      });
    }
    return {
      url: location.href,
      title: document.title || "",
      total: all.length,
      links: all.slice(0, maxItems),
      error: ""
    };
  }, {
    refAttr: REF_ATTR,
    textContains: args.textContains || "",
    urlContains: args.urlContains || "",
    sameOrigin: Boolean(args.sameOrigin),
    external: Boolean(args.external),
    selector: args.selector ? String(args.selector) : "",
    includeHidden: Boolean(args.includeHidden),
    maxItems
  });
  const lines = [
    `Links: ${data.links.length} shown of ${data.total}`,
    `URL: ${data.url}`,
    `Title: ${data.title || "(no title)"}`,
    data.error ? `Error: ${data.error}` : "",
    ""
  ].filter((line) => line !== "");
  if (data.links.length) {
    for (const item of data.links) {
      const target = item.target ? ` target=${item.target}` : "";
      lines.push(`[${item.ref}] ${item.relation}${target} box=${item.box.x},${item.box.y},${item.box.w},${item.box.h} "${item.text}" -> ${item.href}`);
    }
  } else {
    lines.push("(no links)");
  }
  if (data.total > data.links.length) lines.push(`...(+${data.total - data.links.length} more; raise maxItems or filter with textContains/urlContains)`);
  return lines.join("\n");
}

async function browserExtractForms(args = {}) {
  const page = requirePage();
  const maxForms = intArg(args.maxForms, 10, 1, 50);
  const maxFields = intArg(args.maxFields, 80, 1, 300);
  const data = await page.evaluate(({ refAttr, selector, includeHidden, maxForms, maxFields }) => {
    const roots = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.forms);
    const forms = roots.map((root) => root.tagName === "FORM" ? root : root.closest("form")).filter(Boolean);
    const uniqueForms = [];
    const seenForms = new Set();
    for (const form of forms) {
      if (!seenForms.has(form)) {
        seenForms.add(form);
        uniqueForms.push(form);
      }
    }

    function clean(value, max = 160) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
    }

    function isHidden(field) {
      if (field.type === "hidden") return true;
      const style = window.getComputedStyle(field);
      const rect = field.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden" || rect.width <= 1 || rect.height <= 1;
    }

    function labelFor(field) {
      const labels = [];
      if (field.getAttribute("aria-label")) labels.push(field.getAttribute("aria-label"));
      if (field.getAttribute("placeholder")) labels.push(field.getAttribute("placeholder"));
      if (field.id) {
        const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (label) labels.push(label.innerText || label.textContent || "");
      }
      if (field.labels) {
        for (const label of Array.from(field.labels)) labels.push(label.innerText || label.textContent || "");
      }
      return clean(labels.filter(Boolean)[0] || "");
    }

    const result = [];
    let fieldCount = 0;
    for (const form of uniqueForms.slice(0, maxForms)) {
      const formRef = `form-${result.length + 1}`;
      form.setAttribute(refAttr, formRef);
      const fields = [];
      for (const field of Array.from(form.elements || [])) {
        if (fieldCount >= maxFields) break;
        if (!includeHidden && isHidden(field)) continue;
        if (!field.tagName) continue;
        const ref = `field-${fieldCount + 1}`;
        field.setAttribute(refAttr, ref);
        const name = field.getAttribute("name") || "";
        const id = field.getAttribute("id") || "";
        const type = field.getAttribute("type") || field.tagName.toLowerCase();
        const fieldInfo = {
          ref,
          tag: field.tagName.toLowerCase(),
          type,
          name,
          id,
          label: labelFor(field),
          required: Boolean(field.required || field.getAttribute("aria-required") === "true"),
          disabled: Boolean(field.disabled || field.getAttribute("aria-disabled") === "true"),
          hidden: isHidden(field),
          csrfLike: /csrf|xsrf|token|authenticity/i.test(`${name} ${id}`)
        };
        if (field.tagName === "SELECT") {
          fieldInfo.options = Array.from(field.options || []).slice(0, 8).map((option) => clean(option.textContent || option.value, 80));
        }
        fields.push(fieldInfo);
        fieldCount += 1;
      }
      result.push({
        ref: formRef,
        method: (form.getAttribute("method") || "GET").toUpperCase(),
        action: (() => { try { return new URL(form.getAttribute("action") || location.href, location.href).href; } catch { return form.getAttribute("action") || ""; } })(),
        enctype: form.getAttribute("enctype") || "",
        fieldCount: (form.elements || []).length,
        fields
      });
      if (fieldCount >= maxFields) break;
    }
    return {
      url: location.href,
      title: document.title || "",
      totalForms: uniqueForms.length,
      forms: result,
      truncatedFields: fieldCount >= maxFields,
      error: selector && !roots.length ? `selector not found: ${selector}` : ""
    };
  }, {
    refAttr: REF_ATTR,
    selector: args.selector ? String(args.selector) : "",
    includeHidden: args.includeHidden !== false,
    maxForms,
    maxFields
  });
  const lines = [
    `Forms: ${data.forms.length} shown of ${data.totalForms}`,
    `URL: ${data.url}`,
    `Title: ${data.title || "(no title)"}`,
    data.error ? `Error: ${data.error}` : "",
    ""
  ].filter((line) => line !== "");
  if (!data.forms.length) {
    lines.push("(no forms)");
  }
  for (const form of data.forms) {
    const enctype = form.enctype ? ` enctype=${form.enctype}` : "";
    lines.push(`[${form.ref}] ${form.method} ${form.action}${enctype} fields=${form.fieldCount}`);
    for (const field of form.fields) {
      const flags = [
        field.required ? "required" : "",
        field.disabled ? "disabled" : "",
        field.hidden ? "hidden" : "",
        field.csrfLike ? "csrf-like" : ""
      ].filter(Boolean);
      const label = field.label ? ` label="${field.label}"` : "";
      const name = field.name ? ` name=${field.name}` : "";
      const id = field.id ? ` id=${field.id}` : "";
      const options = field.options && field.options.length ? ` options=${field.options.join(" / ")}` : "";
      lines.push(`  [${field.ref}] ${field.tag} type=${field.type}${name}${id}${label}${flags.length ? ` (${flags.join(",")})` : ""}${options}`);
    }
  }
  if (data.truncatedFields) lines.push(`...fields truncated at maxFields=${maxFields}`);
  return lines.join("\n");
}

async function safePageTitle(page, timeoutMs = 1500) {
  try {
    return await Promise.race([page.title(), timeoutAfter(timeoutMs, "page title")]);
  } catch {
    return "";
  }
}

async function browserSwitchPage(args = {}) {
  const pages = currentPages();
  if (!pages.length) throw new Error("No browser pages are open. Call browser_open first.");

  let page = null;
  if (args.latest) {
    page = pages[pages.length - 1];
  } else if (args.ref) {
    page = pages.find((candidate) => pageRef(candidate) === String(args.ref));
  } else if (args.index !== undefined) {
    const index = intArg(args.index, 1, 1, pages.length) - 1;
    page = pages[index];
  } else if (args.urlContains) {
    const needle = String(args.urlContains);
    page = pages.find((candidate) => candidate.url().includes(needle));
  } else if (args.titleContains) {
    const needle = String(args.titleContains).toLowerCase();
    for (const candidate of pages) {
      const title = await safePageTitle(candidate);
      if (title.toLowerCase().includes(needle)) {
        page = candidate;
        break;
      }
    }
  } else {
    throw new Error("Provide ref, index, latest, titleContains, or urlContains.");
  }

  if (!page || page.isClosed()) throw new Error(`Could not find an open page matching: ${JSON.stringify(args)}`);
  setCurrentPage(page);
  await page.bringToFront().catch(() => {});
  await page.waitForLoadState(args.waitUntil || "domcontentloaded", { timeout: 15000 }).catch(() => {});
  return `Selected tab/page ${pageRef(page)}.\n\n${await pageView({})}`;
}

async function locatorFromArgs(page, args = {}, forInput = false) {
  if (args.ref) {
    return page.locator(`[${REF_ATTR}="${String(args.ref)}"]`).first();
  }
  if (args.selector) {
    return page.locator(args.selector).first();
  }
  if (forInput && args.label) {
    return page.getByLabel(args.label).first();
  }
  if (forInput && args.placeholder) {
    return page.getByPlaceholder(args.placeholder).first();
  }
  if (forInput) {
    throw new Error("For typing, provide ref, selector, label, or placeholder as the target.");
  }
  if (args.text) {
    const ref = await setRefByText(page, args.text, forInput);
    if (ref) return page.locator(`[${REF_ATTR}="${ref}"]`).first();
    return page.getByText(args.text, { exact: false }).first();
  }
  throw new Error("Provide ref, selector, text, label, or placeholder.");
}

async function setRefByText(page, text, forInput) {
  return page.evaluate(({ refAttr, text, forInput }) => {
    const needle = String(text || "").trim().toLowerCase();
    if (!needle) return null;
    const selector = forInput
      ? "input,textarea,select,[contenteditable='true']"
      : [
          "a[href]",
          "button",
          "summary",
          "[role='button']",
          "[role='link']",
          "[role='menuitem']",
          "[onclick]",
          "[contenteditable='true']"
        ].join(",");

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }

    function textFor(element) {
      const values = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("placeholder"),
        element.innerText,
        element.textContent,
        element.value
      ];
      return values.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    }

    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isVisible(element)) continue;
      if (!textFor(element).includes(needle)) continue;
      const ref = `text-${Date.now()}`;
      element.setAttribute(refAttr, ref);
      return ref;
    }
    return null;
  }, { refAttr: REF_ATTR, text, forInput });
}

async function browserClick(args = {}) {
  const page = requirePage();
  debugLog(`browser_click start ${JSON.stringify({ ref: args.ref, selector: args.selector, text: args.text, expectDownload: Boolean(args.expectDownload) })}`);
  if (!args.ref && !args.selector) await pageView({ maxElements: 300 });
  debugLog("browser_click locating");
  const locator = await locatorFromArgs(page, args, false);
  debugLog("browser_click located");
  const switchToNewPage = args.switchToNewPage !== false;
  const newPageTimeoutMs = intArg(args.newPageTimeoutMs, 1500, 100, 10000);
  const newPagePromise = switchToNewPage ? waitForNewPage(page, newPageTimeoutMs) : Promise.resolve(null);
  const downloadTimeoutMs = intArg(args.downloadTimeoutMs, 15000, 500, 60000);
  const downloadPromise = args.expectDownload
    ? Promise.race([
        page.waitForEvent("download"),
        timeoutAfter(downloadTimeoutMs, "download")
      ]).catch((error) => ({ error }))
    : Promise.resolve(null);
  if (args.expectDownload) {
    debugLog("browser_click download scroll");
    await Promise.race([locator.scrollIntoViewIfNeeded({ timeout: 15000 }), timeoutAfter(15000, "download target scroll")]);
    debugLog("browser_click download bounds");
    const box = await Promise.race([locator.boundingBox(), timeoutAfter(15000, "download target bounds")]);
    if (!box || box.width <= 0 || box.height <= 0) throw new Error("Download target has no clickable bounding box.");
    debugLog(`browser_click download mouse ${box.x},${box.y},${box.width},${box.height}`);
    await Promise.race([page.mouse.click(box.x + box.width / 2, box.y + box.height / 2), timeoutAfter(15000, "download click")]);
  } else {
    debugLog("browser_click locator click");
    await locator.click({ timeout: 15000 });
  }
  debugLog("browser_click awaiting page/download");
  const [newPage, download] = await Promise.all([newPagePromise, downloadPromise]);
  debugLog("browser_click awaited page/download");
  let downloadLine = "";
  if (args.expectDownload) {
    if (!download || download.error) {
      throw new Error(`Expected download was not captured${download && download.error ? `: ${download.error.message}` : ""}`);
    }
    const dir = path.join(ROOT, ".browser-navigator", "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const suggested = args.downloadName || download.suggestedFilename() || `download-${Date.now()}`;
    const safe = String(suggested).replace(/[^a-zA-Z0-9._-]/g, "_") || `download-${Date.now()}`;
    const filePath = path.join(dir, safe);
    debugLog(`browser_click download save ${filePath}`);
    await Promise.race([download.saveAs(filePath), timeoutAfter(downloadTimeoutMs, "download save")]);
    debugLog("browser_click download saved");
    const record = recordDownload({
      filePath,
      suggestedFilename: download.suggestedFilename ? download.suggestedFilename() : safe,
      url: download.url ? download.url() : "",
      page
    });
    downloadLine = `Download: ${record.path}\nDownload id: ${record.id}`;
  }
  if (downloadLine) {
    setCurrentPage(page);
    debugLog("browser_click returning download line");
    return downloadLine;
  }
  if (newPage && !newPage.isClosed()) {
    setCurrentPage(newPage);
    await newPage.bringToFront().catch(() => {});
    await newPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    if (args.waitMs) await newPage.waitForTimeout(intArg(args.waitMs, 500, 0, 10000));
    return [`New tab/page opened and selected: ${pageRef(newPage)}.`, downloadLine, "", await pageView({})].filter(Boolean).join("\n");
  }
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 500, 0, 10000));
  else await page.waitForTimeout(500);
  const view = await pageView({});
  return downloadLine ? `${downloadLine}\n\n${view}` : view;
}

async function browserHover(args = {}) {
  const page = requirePage();
  if (!args.ref && !args.selector) await pageView({ maxElements: 300 });
  const locator = await locatorFromArgs(page, args, false);
  await locator.hover({ timeout: 15000 });
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 500, 0, 10000));
  else await page.waitForTimeout(500);
  return pageView({});
}

function waitForNewPage(sourcePage, timeoutMs) {
  const before = new Set(currentPages().map((page) => pageRef(page)));
  if (!state.context) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    function finish(page) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sourcePage.off("popup", onPopup);
      state.context.off("page", onContextPage);
      resolve(page || null);
    }

    function findAddedPage() {
      return currentPages().find((page) => !before.has(pageRef(page))) || null;
    }

    function onPopup(page) {
      finish(page);
    }

    function onContextPage(page) {
      if (page !== sourcePage) finish(page);
    }

    sourcePage.on("popup", onPopup);
    state.context.on("page", onContextPage);
    timer = setTimeout(() => finish(findAddedPage()), timeoutMs);
  });
}

async function browserType(args = {}) {
  const page = requirePage();
  if (typeof args.text !== "string") throw new Error("text is required");
  if (!args.ref) await pageView({ maxElements: 300 });
  const locator = await locatorFromArgs(page, args, true);
  if (args.append) {
    await locator.click({ timeout: 15000 });
    await locator.type(args.text, { timeout: 15000 });
  } else {
    await locator.fill(args.text, { timeout: 15000 });
  }
  if (args.submit) await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  return pageView({});
}

async function browserUpload(args = {}) {
  const page = requirePage();
  if (!Array.isArray(args.paths) || !args.paths.length) throw new Error("paths is required");
  if (!args.ref && !args.selector && !args.label) await pageView({ maxElements: 300 });
  let locator;
  if (args.ref || args.selector) locator = await locatorFromArgs(page, args, true);
  else locator = page.getByLabel(String(args.label)).first();
  const files = args.paths.map((item) => explicitLocalPath(item));
  await locator.setInputFiles(files, { timeout: 15000 });
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 300, 0, 10000));
  else await page.waitForTimeout(300);
  return [
    `Uploaded files: ${files.length}`,
    ...files.map((file) => `- ${file}`),
    "",
    await pageView({})
  ].join("\n");
}

async function browserDialog(args = {}) {
  if (args.action) {
    const action = String(args.action).toLowerCase();
    if (!["accept", "dismiss"].includes(action)) throw new Error("action must be accept or dismiss");
    state.dialogPolicy = { action, promptText: args.promptText ? String(args.promptText) : "" };
  }
  const lines = [];
  if (args.action) {
    lines.push(`Dialog handler armed: ${state.dialogPolicy.action}${state.dialogPolicy.promptText ? " with prompt text" : ""}`);
  }
  if (state.lastDialog) {
    lines.push("Last dialog:");
    lines.push(JSON.stringify(state.lastDialog, null, 2));
  } else {
    lines.push("Last dialog: (none)");
  }
  return lines.join("\n");
}

async function browserSelect(args = {}) {
  const page = requirePage();
  if (!args.ref && !args.selector && !args.targetLabel) await pageView({ maxElements: 300 });
  let locator;
  if (args.ref || args.selector) {
    locator = await locatorFromArgs(page, args, true);
  } else if (args.targetLabel) {
    locator = page.getByLabel(String(args.targetLabel)).first();
  } else {
    throw new Error("Provide ref, selector, or targetLabel for the select element.");
  }

  const option = {};
  if (args.value !== undefined) option.value = String(args.value);
  else if (args.optionLabel !== undefined) option.label = String(args.optionLabel);
  else if (args.index !== undefined) option.index = intArg(args.index, 0, 0, 10000);
  else throw new Error("Provide value, optionLabel, or index for the option.");

  await locator.selectOption(option, { timeout: 15000 });
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 300, 0, 10000));
  else await page.waitForTimeout(300);
  return pageView({});
}

async function browserPress(args = {}) {
  const page = requirePage();
  if (!args.key) throw new Error("key is required");
  await page.keyboard.press(String(args.key));
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 500, 0, 10000));
  else await page.waitForTimeout(300);
  return pageView({});
}

async function browserScroll(args = {}) {
  const page = requirePage();
  const direction = String(args.direction || "down").toLowerCase();
  const pixels = args.pixels === undefined ? null : intArg(args.pixels, 0, 1, 10000);
  if (args.ref || args.selector) {
    const locator = await locatorFromArgs(page, args, false);
    await locator.evaluate((element, { direction, pixels }) => {
      const amount = pixels || Math.max(240, Math.round((element.clientHeight || window.innerHeight || 800) * 0.8));
      if (direction === "top") element.scrollTo({ top: 0 });
      else if (direction === "bottom") element.scrollTo({ top: element.scrollHeight });
      else if (direction === "up") element.scrollBy({ top: -amount });
      else if (direction === "left") element.scrollBy({ left: -amount });
      else if (direction === "right") element.scrollBy({ left: amount });
      else element.scrollBy({ top: amount });
    }, { direction, pixels });
  } else {
    await page.evaluate(({ direction, pixels }) => {
      const amount = pixels || Math.max(240, Math.round(window.innerHeight * 0.8));
      const pageHeight = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      if (direction === "top") window.scrollTo({ top: 0, left: window.scrollX });
      else if (direction === "bottom") window.scrollTo({ top: pageHeight, left: window.scrollX });
      else if (direction === "up") window.scrollBy({ top: -amount });
      else if (direction === "left") window.scrollBy({ left: -amount });
      else if (direction === "right") window.scrollBy({ left: amount });
      else window.scrollBy({ top: amount });
    }, { direction, pixels });
  }
  if (args.waitMs) await page.waitForTimeout(intArg(args.waitMs, 300, 0, 10000));
  else await page.waitForTimeout(300);
  return pageView({});
}

async function browserWait(args = {}) {
  const page = requirePage();
  const timeout = intArg(args.timeoutMs, 10000, 100, 60000);
  if (args.delayMs !== undefined) await page.waitForTimeout(intArg(args.delayMs, 0, 0, 60000));
  if (args.selector) await page.waitForSelector(args.selector, { timeout });
  if (args.text) await page.getByText(args.text, { exact: false }).first().waitFor({ timeout });
  if (args.urlContains) {
    const target = String(args.urlContains);
    await page.waitForURL((url) => url.href.includes(target), { timeout });
  }
  return pageView({});
}

async function browserAssert(args = {}) {
  const page = requirePage();
  const timeout = intArg(args.timeoutMs, 2000, 0, 60000);
  const negate = Boolean(args.negate);
  const checks = [];

  async function runCheck(label, fn) {
    const started = Date.now();
    let lastError = "";
    while (true) {
      try {
        const value = await fn();
        const passed = negate ? !value : Boolean(value);
        if (passed) {
          checks.push(`PASS ${label}`);
          return;
        }
      } catch (error) {
        lastError = error.message;
        if (negate) {
          checks.push(`PASS ${label} (absent/error as expected)`);
          return;
        }
      }
      if (Date.now() - started >= timeout) {
        const suffix = lastError ? ` Last error: ${lastError}` : "";
        throw new Error(`Assertion failed: ${negate ? "expected absence of " : "expected "}${label}.${suffix}`);
      }
      await page.waitForTimeout(Math.min(250, Math.max(50, timeout || 50)));
    }
  }

  if (args.text) {
    const text = String(args.text);
    await runCheck(`text ${JSON.stringify(text)}`, async () => {
      if (args.exact) {
        return await page.getByText(text, { exact: true }).first().isVisible({ timeout: Math.min(timeout || 1, 1000) }).catch(() => false);
      }
      return (await page.locator("body").innerText({ timeout: Math.min(timeout || 1, 1000) })).includes(text);
    });
  }
  if (args.selector) {
    const selector = String(args.selector);
    await runCheck(`selector ${selector}${args.visible === false ? "" : " visible"}`, async () => {
      const locator = page.locator(selector).first();
      if (args.visible === false) return await locator.count().then((count) => count > 0);
      return await locator.isVisible({ timeout: Math.min(timeout || 1, 1000) }).catch(() => false);
    });
  }
  if (args.urlContains) {
    const needle = String(args.urlContains);
    await runCheck(`url contains ${JSON.stringify(needle)}`, async () => page.url().includes(needle));
  }
  if (args.titleContains) {
    const needle = String(args.titleContains);
    await runCheck(`title contains ${JSON.stringify(needle)}`, async () => (await safePageTitle(page)).includes(needle));
  }
  if (!checks.length) throw new Error("Provide at least one of text, selector, urlContains, or titleContains.");
  return [`browser_assert ${negate ? "absence" : "presence"}: PASS`, ...checks].join("\n");
}

async function browserBack(args = {}) {
  const page = requirePage();
  await page.goBack({ waitUntil: args.waitUntil || "domcontentloaded", timeout: 30000 });
  return pageView({});
}

async function browserReload(args = {}) {
  const page = requirePage();
  await page.reload({
    waitUntil: args.waitUntil || "domcontentloaded",
    timeout: intArg(args.timeoutMs, 30000, 1000, 60000)
  });
  return pageView({});
}

async function browserScreenshot(args = {}) {
  const page = requirePage();
  const dir = path.join(ROOT, ".browser-navigator", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = args.name ? String(args.name).replace(/[^a-zA-Z0-9._-]/g, "_") : `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  const filePath = path.join(dir, safeName.endsWith(".png") ? safeName : `${safeName}.png`);
  if (args.ref || args.selector) {
    const locator = await locatorFromArgs(page, args, false);
    await locator.screenshot({ path: filePath, timeout: 15000 });
    return `Element screenshot: ${filePath}`;
  }
  await page.screenshot({ path: filePath, fullPage: Boolean(args.fullPage) });
  return `Screenshot: ${filePath}`;
}

function browserHeader(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) return String(value || "");
  }
  return "";
}

function addSecurityFinding(findings, severity, title, detail, fix) {
  findings.push({ severity, title, detail, fix });
}

function summarizeSecurityFindings(findings) {
  if (!findings.length) return ["No obvious page-level issues found by this browser snapshot."];
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  return findings
    .slice()
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
    .map((item) => `- [${item.severity}] ${item.title}: ${item.detail}${item.fix ? ` | Fix: ${item.fix}` : ""}`);
}

function browserSecurityHeaderFindings(snapshot) {
  const findings = [];
  const headers = snapshot.headers || {};
  const url = snapshot.url || "";
  const isHttps = /^https:/i.test(url);
  const hsts = browserHeader(headers, "strict-transport-security");
  const csp = browserHeader(headers, "content-security-policy");
  const xfo = browserHeader(headers, "x-frame-options");
  const xcto = browserHeader(headers, "x-content-type-options");
  const referrer = browserHeader(headers, "referrer-policy");
  const permissions = browserHeader(headers, "permissions-policy");
  if (!snapshot.isSecureContext) addSecurityFinding(findings, "medium", "Page is not a secure context", url, "Use HTTPS for production pages.");
  if (isHttps && !hsts) addSecurityFinding(findings, "medium", "HSTS not visible to page fetch", "(absent or not exposed)", "Confirm server sends Strict-Transport-Security on HTTPS responses.");
  if (!csp) addSecurityFinding(findings, "medium", "Missing Content-Security-Policy", "(absent or not exposed)", "Add a CSP tuned to the app.");
  else {
    if (/unsafe-inline/i.test(csp)) addSecurityFinding(findings, "low", "CSP allows unsafe-inline", truncateText(csp, 240), "Prefer nonces or hashes.");
    if (/unsafe-eval/i.test(csp)) addSecurityFinding(findings, "medium", "CSP allows unsafe-eval", truncateText(csp, 240), "Remove unsafe-eval if possible.");
    if (!/\bframe-ancestors\b/i.test(csp) && !xfo) addSecurityFinding(findings, "medium", "No clickjacking policy", "Missing CSP frame-ancestors and X-Frame-Options.", "Set frame-ancestors or X-Frame-Options.");
  }
  if (!xcto || !/nosniff/i.test(xcto)) addSecurityFinding(findings, "low", "Missing X-Content-Type-Options nosniff", xcto || "(absent)", "Set X-Content-Type-Options: nosniff.");
  if (!referrer) addSecurityFinding(findings, "low", "Missing Referrer-Policy", "(absent)", "Set strict-origin-when-cross-origin or stricter.");
  if (!permissions) addSecurityFinding(findings, "info", "Missing Permissions-Policy", "(absent)", "Disable unused powerful browser features.");
  return findings;
}

async function browserSecuritySnapshot(args = {}) {
  const page = requirePage();
  const maxItems = intArg(args.maxItems, 12, 3, 50);
  const cookies = state.context ? await state.context.cookies([page.url()]) : [];
  const snapshot = await page.evaluate(async ({ maxItems }) => {
    function text(value, max = 160) {
      const s = String(value || "").replace(/\s+/g, " ").trim();
      return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
    }
    function absolute(value) {
      if (!value) return "";
      try { return new URL(value, location.href).href; } catch { return String(value); }
    }
    const headers = {};
    let headerStatus = "";
    let headerError = "";
    try {
      const response = await fetch(location.href, { method: "GET", credentials: "include", cache: "no-store" });
      headerStatus = String(response.status);
      response.headers.forEach((value, key) => { headers[key] = value; });
    } catch (error) {
      headerError = error.message;
    }
    const forms = Array.from(document.forms).slice(0, maxItems).map((form, index) => {
      const fields = Array.from(form.elements || []);
      const names = fields.map((field) => field.getAttribute && (field.getAttribute("name") || field.getAttribute("id") || field.getAttribute("type"))).filter(Boolean);
      return {
        index,
        method: (form.getAttribute("method") || "GET").toUpperCase(),
        action: absolute(form.getAttribute("action") || location.href),
        inputCount: fields.length,
        passwordInputs: fields.filter((field) => field.type === "password").length,
        fileInputs: fields.filter((field) => field.type === "file").length,
        hiddenInputs: fields.filter((field) => field.type === "hidden").length,
        csrfLike: names.filter((name) => /csrf|xsrf|token|authenticity/i.test(name)).slice(0, 5),
        sampleNames: names.slice(0, 8)
      };
    });
    const resourceSelectors = [
      ["script", "src"],
      ["link[rel='stylesheet']", "href"],
      ["img", "src"],
      ["iframe", "src"],
      ["source", "src"]
    ];
    const resources = [];
    for (const [selector, attr] of resourceSelectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        const url = absolute(element.getAttribute(attr));
        if (url) {
          resources.push({
            tag: element.tagName.toLowerCase(),
            url,
            integrity: element.getAttribute("integrity") || "",
            crossorigin: element.getAttribute("crossorigin") || ""
          });
        }
      }
    }
    const origin = location.origin;
    const scripts = Array.from(document.scripts);
    const externalScripts = scripts.filter((script) => script.src);
    const inlineScripts = scripts.filter((script) => !script.src && text(script.textContent, 20));
    const crossOriginNoSri = externalScripts.filter((script) => {
      try { return new URL(script.src).origin !== origin && !script.integrity; } catch { return false; }
    }).map((script) => script.src).slice(0, maxItems);
    const mixed = /^https:/i.test(location.protocol)
      ? resources.filter((item) => /^http:/i.test(item.url)).slice(0, maxItems)
      : [];
    const iframes = Array.from(document.querySelectorAll("iframe")).slice(0, maxItems).map((iframe) => ({
      src: absolute(iframe.getAttribute("src") || ""),
      sandbox: iframe.getAttribute("sandbox") || "",
      allow: iframe.getAttribute("allow") || ""
    }));
    return {
      url: location.href,
      title: document.title || "",
      isSecureContext: window.isSecureContext,
      headerStatus,
      headerError,
      headers,
      forms,
      formTotal: document.forms.length,
      resources: resources.slice(0, maxItems),
      resourceTotal: resources.length,
      mixed,
      scripts: {
        external: externalScripts.length,
        inline: inlineScripts.length,
        crossOriginNoSri
      },
      iframes,
      iframeTotal: document.querySelectorAll("iframe").length,
      storage: {
        localStorageKeys: (() => { try { return Object.keys(localStorage).slice(0, maxItems); } catch { return []; } })(),
        sessionStorageKeys: (() => { try { return Object.keys(sessionStorage).slice(0, maxItems); } catch { return []; } })()
      }
    };
  }, { maxItems });

  const findings = browserSecurityHeaderFindings(snapshot);
  if (snapshot.headerError) addSecurityFinding(findings, "info", "Could not read current-page headers from page context", snapshot.headerError, "Use security-doctor security_http_headers for a server-side header check.");
  for (const cookie of cookies.slice(0, maxItems)) {
    if (/^https:/i.test(snapshot.url) && !cookie.secure) addSecurityFinding(findings, "medium", `Cookie ${cookie.name} missing Secure`, `${cookie.domain}${cookie.path}`, "Set Secure on HTTPS cookies.");
    if (!cookie.httpOnly) addSecurityFinding(findings, "low", `Cookie ${cookie.name} missing HttpOnly`, `${cookie.domain}${cookie.path}`, "Set HttpOnly for cookies JavaScript does not need.");
    if (!cookie.sameSite || String(cookie.sameSite).toLowerCase() === "none" && !cookie.secure) addSecurityFinding(findings, "low", `Cookie ${cookie.name} SameSite needs review`, `sameSite=${cookie.sameSite || "(unset)"}`, "Use Lax/Strict for most cookies; SameSite=None requires Secure.");
  }
  for (const form of snapshot.forms) {
    if (/^http:/i.test(form.action) && /^https:/i.test(snapshot.url)) addSecurityFinding(findings, "high", "HTTPS page submits form to HTTP", form.action, "Submit sensitive forms over HTTPS.");
    if (form.method === "POST" && !form.csrfLike.length) addSecurityFinding(findings, "low", "POST form has no obvious CSRF token field", `form#${form.index} ${form.action}`, "Confirm server-side CSRF or same-site protections.");
    if (form.passwordInputs && !/^https:/i.test(form.action)) addSecurityFinding(findings, "high", "Password form action is not HTTPS", form.action, "Use HTTPS for password submission.");
  }
  if (snapshot.mixed.length) addSecurityFinding(findings, "high", "Mixed content references found", `${snapshot.mixed.length} shown`, "Load all active/passive resources over HTTPS.");
  if (snapshot.scripts.crossOriginNoSri.length) addSecurityFinding(findings, "info", "Cross-origin scripts without SRI", `${snapshot.scripts.crossOriginNoSri.length} shown`, "Consider Subresource Integrity for stable third-party scripts.");
  const sandboxless = snapshot.iframes.filter((item) => item.src && !item.sandbox);
  if (sandboxless.length) addSecurityFinding(findings, "low", "Iframes without sandbox", `${sandboxless.length} shown`, "Sandbox untrusted embedded content.");

  const recentNetwork = state.networkEntries.slice(-maxItems).map((entry) => `${entry.status || "pending"} ${entry.method} ${entry.resourceType} ${entry.url}`);
  const cookieLines = cookies.slice(0, maxItems).map((cookie) => {
    const flags = [
      cookie.secure ? "Secure" : "no-Secure",
      cookie.httpOnly ? "HttpOnly" : "no-HttpOnly",
      `SameSite=${cookie.sameSite || "(unset)"}`
    ];
    return `- ${cookie.name} ${cookie.domain}${cookie.path} ${flags.join(" ")}`;
  });
  const formLines = snapshot.forms.map((form) => `- #${form.index} ${form.method} ${form.action} inputs=${form.inputCount} password=${form.passwordInputs} file=${form.fileInputs} hidden=${form.hiddenInputs} csrfLike=${form.csrfLike.join(",") || "(none)"}`);
  const resourceLines = snapshot.resources.map((item) => `- ${item.tag} ${item.url}${item.integrity ? " integrity" : ""}`);
  const mixedLines = snapshot.mixed.map((item) => `- ${item.tag} ${item.url}`);
  return [
    `browser security snapshot: ${snapshot.url}`,
    `Title: ${snapshot.title || "(no title)"}`,
    `Secure context: ${snapshot.isSecureContext}`,
    `Header fetch: ${snapshot.headerStatus || "(none)"}${snapshot.headerError ? ` error=${snapshot.headerError}` : ""}`,
    "",
    "Readable security headers:",
    `- strict-transport-security: ${browserHeader(snapshot.headers, "strict-transport-security") || "(absent/not exposed)"}`,
    `- content-security-policy: ${truncateText(browserHeader(snapshot.headers, "content-security-policy") || "(absent/not exposed)", 500)}`,
    `- x-frame-options: ${browserHeader(snapshot.headers, "x-frame-options") || "(absent/not exposed)"}`,
    `- x-content-type-options: ${browserHeader(snapshot.headers, "x-content-type-options") || "(absent/not exposed)"}`,
    `- referrer-policy: ${browserHeader(snapshot.headers, "referrer-policy") || "(absent/not exposed)"}`,
    `- permissions-policy: ${truncateText(browserHeader(snapshot.headers, "permissions-policy") || "(absent/not exposed)", 300)}`,
    "",
    `Cookies (${cookieLines.length} shown of ${cookies.length}):`,
    ...(cookieLines.length ? cookieLines : ["(none visible to browser context)"]),
    "",
    `Forms (${formLines.length} shown of ${snapshot.formTotal}):`,
    ...(formLines.length ? formLines : ["(none)"]),
    "",
    `Resources (${resourceLines.length} shown of ${snapshot.resourceTotal}), scripts external=${snapshot.scripts.external} inline=${snapshot.scripts.inline}:`,
    ...(resourceLines.length ? resourceLines : ["(none)"]),
    "",
    `Mixed content (${mixedLines.length} shown):`,
    ...(mixedLines.length ? mixedLines : ["(none)"]),
    "",
    `Cross-origin scripts without SRI (${snapshot.scripts.crossOriginNoSri.length} shown):`,
    ...(snapshot.scripts.crossOriginNoSri.length ? snapshot.scripts.crossOriginNoSri.map((url) => `- ${url}`) : ["(none)"]),
    "",
    `Iframes (${snapshot.iframes.length} shown of ${snapshot.iframeTotal}):`,
    ...(snapshot.iframes.length ? snapshot.iframes.map((item) => `- ${item.src || "(empty src)"} sandbox=${item.sandbox || "(none)"}`) : ["(none)"]),
    "",
    `Storage keys: local=${snapshot.storage.localStorageKeys.join(", ") || "(none)"} | session=${snapshot.storage.sessionStorageKeys.join(", ") || "(none)"}`,
    "",
    "Recent fetch/XHR:",
    ...(recentNetwork.length ? recentNetwork.map((line) => `- ${line}`) : ["(none captured yet)"]),
    "",
    "Findings:",
    ...summarizeSecurityFindings(findings)
  ].join("\n");
}

function stringifyResult(value, maxChars) {
  let text;
  if (value === undefined) {
    text = "undefined";
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return truncateText(text, maxChars);
}

function timeoutAfter(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

async function browserEvaluate(args = {}) {
  const page = requirePage();
  if (typeof args.script !== "string" || !args.script.trim()) throw new Error("script is required");
  const maxChars = intArg(args.maxChars, 20000, 1000, 200000);
  const timeoutMs = intArg(args.timeoutMs, 15000, 1000, 60000);
  const value = await Promise.race([
    page.evaluate(
      async ({ script, arg, awaitPromise }) => {
        function runScript() {
          try {
            return new Function("arg", `"use strict"; return (${script});`)(arg);
          } catch (expressionError) {
            try {
              return new Function("arg", `"use strict"; ${script}`)(arg);
            } catch (statementError) {
              statementError.message = `${statementError.message}; expression parse error: ${expressionError.message}`;
              throw statementError;
            }
          }
        }
        const result = runScript();
        return awaitPromise === false ? result : await result;
      },
      {
        script: args.script,
        arg: Object.prototype.hasOwnProperty.call(args, "arg") ? args.arg : null,
        awaitPromise: args.awaitPromise !== false
      }
    ),
    timeoutAfter(timeoutMs, "browser_evaluate")
  ]);
  return `Evaluation result:\n${stringifyResult(value, maxChars)}`;
}

function filteredNetworkEntries(args = {}) {
  const resourceTypes = Array.isArray(args.resourceTypes) && args.resourceTypes.length
    ? new Set(args.resourceTypes.map((item) => String(item).toLowerCase()))
    : TRACKED_NETWORK_TYPES;
  const urlContains = args.urlContains ? String(args.urlContains) : "";
  const statusMin = args.statusMin === undefined ? null : intArg(args.statusMin, 100, 100, 599);

  return state.networkEntries.filter((entry) => {
    if (!resourceTypes.has(String(entry.resourceType).toLowerCase())) return false;
    if (urlContains && !entry.url.includes(urlContains)) return false;
    if (statusMin !== null && (typeof entry.status !== "number" || entry.status < statusMin)) return false;
    return true;
  });
}

function networkEntrySummary(entry, args = {}) {
  const parts = [
    `[${entry.id}]`,
    String(entry.status || "pending"),
    entry.method,
    entry.resourceType,
    entry.url
  ].filter(Boolean);
  const lines = [parts.join(" | ")];
  if (entry.requestBodyPreview && args.includeBodies) {
    lines.push(`  requestBody: ${truncateText(entry.requestBodyPreview, 1000).replace(/\n/g, "\\n")}`);
  }
  if (entry.responseBodyPreview && args.includeBodies) {
    lines.push(`  responseBody: ${truncateText(entry.responseBodyPreview, 1000).replace(/\n/g, "\\n")}`);
  }
  if (args.includeHeaders) {
    lines.push(`  requestHeaders: ${JSON.stringify(entry.requestHeaders || {})}`);
    lines.push(`  responseHeaders: ${JSON.stringify(entry.responseHeaders || {})}`);
  }
  if (entry.failure) lines.push(`  failure: ${entry.failure}`);
  return lines.join("\n");
}

async function browserNetwork(args = {}) {
  requirePage();
  const maxEntries = intArg(args.maxEntries, 30, 1, 100);
  const entries = filteredNetworkEntries(args).slice(-maxEntries);
  if (!entries.length) return "No captured fetch/XHR network entries. Trigger the page action, then call browser_network again.";
  const lines = [
    `Captured fetch/XHR entries (${entries.length} shown, newest last):`,
    ...entries.map((entry) => networkEntrySummary(entry, args)),
    "",
    "Use browser_network_get with an entry id for full details."
  ];
  return lines.join("\n");
}

async function browserNetworkGet(args = {}) {
  if (!args.id) throw new Error("id is required");
  const entry = state.networkEntries.find((candidate) => candidate.id === String(args.id));
  if (!entry) throw new Error(`No network entry found for id: ${args.id}`);
  const includeHeaders = args.includeHeaders !== false;
  const includeBodies = args.includeBodies !== false;
  const maxBodyChars = intArg(args.maxBodyChars, 20000, 1000, 200000);
  const detail = {
    id: entry.id,
    time: entry.time,
    page: entry.page,
    resourceType: entry.resourceType,
    request: {
      method: entry.method,
      url: entry.url
    },
    response: {
      status: entry.status,
      ok: entry.ok,
      contentType: entry.contentType || undefined,
      bodyError: entry.responseBodyError || undefined
    },
    failure: entry.failure || undefined,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    ok: entry.ok,
    contentType: entry.contentType || undefined,
    responseBodyError: entry.responseBodyError || undefined
  };
  if (includeHeaders) {
    detail.request.headers = entry.requestHeaders || {};
    detail.response.headers = entry.responseHeaders || {};
    detail.requestHeaders = detail.request.headers;
    detail.responseHeaders = detail.response.headers;
  }
  if (includeBodies) {
    detail.request.bodyPreview = truncateText(entry.requestBodyPreview || "", maxBodyChars);
    detail.response.bodyPreview = truncateText(entry.responseBodyPreview || "", maxBodyChars);
    detail.requestBodyPreview = detail.request.bodyPreview;
    detail.responseBodyPreview = detail.response.bodyPreview;
  }
  return JSON.stringify(detail, null, 2);
}

async function browserNetworkClear() {
  state.networkEntries = [];
  state.networkLogs = [];
  state.networkSeq = 0;
  return "Browser network capture logs cleared.";
}

async function browserNetworkWait(args = {}) {
  requirePage();
  const timeoutMs = intArg(args.timeoutMs, 10000, 100, 60000);
  const started = Date.now();
  const includeBodies = Boolean(args.includeBodies);
  function matches(entry) {
    const resourceTypes = Array.isArray(args.resourceTypes) && args.resourceTypes.length
      ? new Set(args.resourceTypes.map((item) => String(item).toLowerCase()))
      : TRACKED_NETWORK_TYPES;
    if (!resourceTypes.has(String(entry.resourceType).toLowerCase())) return false;
    if (args.urlContains && !entry.url.includes(String(args.urlContains))) return false;
    if (args.method && String(entry.method).toUpperCase() !== String(args.method).toUpperCase()) return false;
    if (args.status !== undefined && entry.status !== intArg(args.status, 0, 100, 599)) return false;
    if (args.statusMin !== undefined && (typeof entry.status !== "number" || entry.status < intArg(args.statusMin, 100, 100, 599))) return false;
    if (entry.status === "pending") return false;
    return true;
  }
  while (Date.now() - started <= timeoutMs) {
    const entry = state.networkEntries.slice().reverse().find(matches);
    if (entry) {
      return [
        `Matched network entry after ${Date.now() - started}ms:`,
        networkEntrySummary(entry, { includeBodies }),
        "",
        "Use browser_network_get with this id for full details."
      ].join("\n");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const filters = JSON.stringify({
    urlContains: args.urlContains || "",
    method: args.method || "",
    status: args.status,
    statusMin: args.statusMin,
    resourceTypes: args.resourceTypes || ["fetch", "xhr"]
  });
  throw new Error(`Timed out after ${timeoutMs}ms waiting for network entry matching ${filters}`);
}

async function browserConsole(args = {}) {
  requirePage();
  const maxEntries = intArg(args.maxEntries, 20, 1, 100);
  const defaultLevels = ["error", "warning", "assert"];
  const levels = Array.isArray(args.levels) && args.levels.length
    ? new Set(args.levels.map((item) => String(item).toLowerCase()))
    : new Set(defaultLevels);
  const includePageErrors = args.includePageErrors !== false;
  const consoleItems = state.consoleLogs
    .filter((item) => levels.has(String(item.type).toLowerCase()))
    .map((item) => ({
      source: "console",
      time: item.time,
      page: item.page,
      type: item.type,
      text: item.text,
      location: item.location
    }));
  const pageErrorItems = includePageErrors
    ? state.pageErrors.map((item) => ({
        source: "pageerror",
        time: item.time,
        page: item.page,
        type: "pageerror",
        text: item.message,
        location: {}
      }))
    : [];
  const items = [...consoleItems, ...pageErrorItems]
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .slice(-maxEntries);
  const lines = [
    `Console entries: ${items.length} shown`,
    `Levels: ${[...levels].join(", ")}${includePageErrors ? " + pageerror" : ""}`,
    ""
  ];
  if (!items.length) {
    lines.push("(none)");
  } else {
    for (const item of items) {
      const loc = item.location && item.location.url ? ` @ ${item.location.url}:${item.location.lineNumber || 0}:${item.location.columnNumber || 0}` : "";
      lines.push(`- ${item.time || ""} ${item.page || ""} ${item.type}: ${truncateText(item.text || "", 1000).replace(/\n/g, "\\n")}${loc}`);
    }
  }
  return lines.join("\n");
}

async function browserDownloads(args = {}) {
  const maxItems = intArg(args.maxItems, 10, 1, 50);
  const items = state.downloads.slice(-maxItems);
  if (!items.length) return "No downloads recorded in this browser session. Use browser_click with expectDownload:true when clicking download/export buttons.";
  return [
    `Recent downloads (${items.length} shown, newest last):`,
    ...items.map(formatDownload)
  ].join("\n");
}

async function browserClose() {
  const launchedCdp = state.browserKind === "cdp" && state.cdpLaunchedByPlugin;
  await closeBrowser({ closeLaunchedCdp: true });
  return launchedCdp ? "Browser session closed and plugin-launched CDP browser was closed if still running." : "Browser closed.";
}

async function callTool(name, args) {
  if (name === "browser_open") return browserOpen(args);
  if (name === "browser_view") return pageView(args);
  if (name === "browser_find") return browserFind(args);
  if (name === "browser_extract_table") return browserExtractTable(args);
  if (name === "browser_extract_links") return browserExtractLinks(args);
  if (name === "browser_extract_forms") return browserExtractForms(args);
  if (name === "browser_evaluate") return browserEvaluate(args);
  if (name === "browser_network") return browserNetwork(args);
  if (name === "browser_network_get") return browserNetworkGet(args);
  if (name === "browser_network_clear") return browserNetworkClear(args);
  if (name === "browser_network_wait") return browserNetworkWait(args);
  if (name === "browser_console") return browserConsole(args);
  if (name === "browser_downloads") return browserDownloads(args);
  if (name === "browser_pages") return browserPages(args);
  if (name === "browser_session") return browserSession(args);
  if (name === "browser_switch_page") return browserSwitchPage(args);
  if (name === "browser_click") return browserClick(args);
  if (name === "browser_hover") return browserHover(args);
  if (name === "browser_type") return browserType(args);
  if (name === "browser_upload") return browserUpload(args);
  if (name === "browser_dialog") return browserDialog(args);
  if (name === "browser_select") return browserSelect(args);
  if (name === "browser_press") return browserPress(args);
  if (name === "browser_scroll") return browserScroll(args);
  if (name === "browser_wait") return browserWait(args);
  if (name === "browser_assert") return browserAssert(args);
  if (name === "browser_back") return browserBack(args);
  if (name === "browser_reload") return browserReload(args);
  if (name === "browser_screenshot") return browserScreenshot(args);
  if (name === "browser_security_snapshot") return browserSecuritySnapshot(args);
  if (name === "browser_close") return browserClose(args);
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  const id = message.id;
  try {
    if (message.method === "initialize") {
      ok(id, {
        protocolVersion: message.params && message.params.protocolVersion ? message.params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "ping") {
      ok(id, {});
      return;
    }
    if (message.method === "tools/list") {
      ok(id, { tools });
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = message.params && message.params.arguments ? message.params.arguments : {};
      const text = await callTool(name, args);
      toolResult(id, text);
      return;
    }
    if (id !== undefined) errorResponse(id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    if (id !== undefined) toolResult(id, `Error: ${error.message}`, true);
  }
}

function createStdioParser(onMessage) {
  let buffer = Buffer.alloc(0);

  function parseJsonLine() {
    const index = buffer.indexOf(0x0a);
    if (index === -1) return false;
    const line = buffer.slice(0, index).toString("utf8").trim();
    buffer = buffer.slice(index + 1);
    if (line) onMessage(JSON.parse(line));
    return true;
  }

  function parseHeaderFrame() {
    const marker = buffer.indexOf("\r\n\r\n");
    if (marker === -1) return false;
    const header = buffer.slice(0, marker).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) throw new Error("Missing Content-Length header");
    const length = Number.parseInt(match[1], 10);
    const start = marker + 4;
    const end = start + length;
    if (buffer.length < end) return false;
    const json = buffer.slice(start, end).toString("utf8");
    buffer = buffer.slice(end);
    onMessage(JSON.parse(json));
    return true;
  }

  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length) {
      const text = buffer.toString("utf8", 0, Math.min(buffer.length, 32));
      const parsed = text.startsWith("Content-Length:") ? parseHeaderFrame() : parseJsonLine();
      if (!parsed) break;
    }
  };
}

async function selfTest() {
  let testServer = null;
  const serverPort = await new Promise((resolve, reject) => {
    testServer = http.createServer((request, response) => {
      if (request.url && request.url.startsWith("/api/self-test")) {
        response.writeHead(200, {
          "content-type": "application/json",
          "access-control-allow-origin": "*"
        });
        response.end(JSON.stringify({ ok: true, source: "self-test", path: request.url }));
        return;
      }
      if (request.url && request.url.startsWith("/download")) {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": "attachment; filename=self-test-download.txt"
        });
        response.end("download ok");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "geolocation=(), camera=(), microphone=()",
        "set-cookie": "browser_self_test=1; HttpOnly; SameSite=Lax"
      });
      response.end(pageHtml);
    });
    testServer.once("error", reject);
    testServer.listen(0, "127.0.0.1", () => resolve(testServer.address().port));
  });
  const popupHtml = [
    "<!doctype html><html><head><title>Popup Tab</title></head><body>",
    "<h1>Popup content ready</h1>",
    "</body></html>"
  ].join("");
  const popupScript = [
    `const popup = window.open("about:blank", "_blank");`,
    `popup.document.write(${JSON.stringify(popupHtml)});`,
    "popup.document.close();"
  ].join(" ");
  const escapedPopupScript = popupScript.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const pageHtml = [
    "<!doctype html><html><head><title>Navigator Test</title><style>#hover-menu .submenu{display:none}#hover-menu:hover .submenu{display:block}</style></head><body style='min-height:3200px'>",
    "<nav><a href='#chapter'>Directory</a><a id='docs-link' href='/docs/start'>Docs start</a><button id='expand'>Expand</button></nav>",
    "<main><h1>Navigator test page</h1><input placeholder='Search courses'>",
    "<form id='login' method='post' action='/login'><input type='hidden' name='csrf_token' value='test'><input type='password' name='password'><button>Sign in</button></form>",
    "<table id='scores'><caption>Course scores</caption><thead><tr><th>Course</th><th>Score</th></tr></thead><tbody><tr><td>Database</td><td>95</td></tr><tr><td>Python</td><td>98</td></tr></tbody></table>",
    "<div id='hover-menu'>Hover menu<span class='submenu'>Hover panel ready</span></div>",
    "<label for='upload'>Upload</label><input id='upload' type='file' multiple onchange=\"document.body.insertAdjacentHTML('beforeend','<p id=uploaded>Upload ready</p>')\">",
    "<label for='course'>Course</label><select id='course'><option value='python'>Python</option><option value='database'>Database</option></select>",
    "<button id='prompt' onclick=\"document.body.dataset.promptValue=window.prompt('Self test prompt','default') || ''\">Prompt</button>",
    "<a id='download' href='/download' download='self-test-download.txt'>Download file</a>",
    "<button id='next-step' onclick=\"console.log('next step clicked'); document.body.insertAdjacentHTML('beforeend','<p id=done>Directory expanded</p>')\">Next step</button>",
    "<button id='console-error' onclick=\"console.error('self test console error')\">Console error</button>",
    `<button id="open-popup" onclick="${escapedPopupScript}">Open new tab</button>`,
    "<div style='height:2400px'>Long content spacer for scrolling</div>",
    "<section id='chapter'>Chapter 1: Python basics</section></main>",
    "</body></html>"
  ].join("");
  try {
    const uploadFile = path.join(ROOT, ".browser-navigator", "upload-self-test.txt");
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, "upload ok", "utf8");
    const view = await browserOpen({ url: `http://127.0.0.1:${serverPort}/`, visible: false });
    await browserEvaluate({ script: "localStorage.setItem('browserNavigatorStorageSelfTest', 'ok')" });
    const savedSession = await browserSession({ action: "save_storage", name: "self-test" });
    const loadedSession = await browserSession({ action: "load_storage", name: "self-test", visible: false, url: `http://127.0.0.1:${serverPort}/` });
    const loadedStorage = await browserEvaluate({ script: "localStorage.getItem('browserNavigatorStorageSelfTest')" });
    const sessionStatus = await browserSession({ action: "status" });
    const find = await browserFind({ query: "Database", maxMatches: 5 });
    const table = await browserExtractTable({ selector: "#scores", maxRows: 5 });
    const links = await browserExtractLinks({ textContains: "Docs", maxItems: 5 });
    const forms = await browserExtractForms({ selector: "#login" });
    const hover = await browserHover({ selector: "#hover-menu", waitMs: 200 });
    const asserted = await browserAssert({ text: "Navigator test page", selector: "#scores" });
    const reloaded = await browserReload({});
    const upload = await browserUpload({ label: "Upload", paths: [uploadFile] });
    const elementShot = await browserScreenshot({ selector: "#chapter", name: "element-self-test" });
    const securitySnapshot = await browserSecuritySnapshot({ maxItems: 8 });
    const armedDialog = await browserDialog({ action: "accept", promptText: "accepted prompt" });
    const promptResult = await browserEvaluate({ script: "window.prompt('Self test prompt','default')" });
    const evalResult = await browserEvaluate({ script: "document.title" });
    const fetchUrl = `http://127.0.0.1:${serverPort}/api/self-test?query=browser`;
    const fetchResult = await browserEvaluate({ script: `(async () => await fetch(${JSON.stringify(fetchUrl)}).then((r) => r.json()))()` });
    const waitedNetwork = await browserNetworkWait({ urlContains: "/api/self-test", includeBodies: true, timeoutMs: 5000 });
    await requirePage().waitForTimeout(250);
    const network = await browserNetwork({ includeBodies: true });
    const firstNetworkId = (network.match(/\[(n\d+)\]/) || [])[1];
    const networkDetail = firstNetworkId ? await browserNetworkGet({ id: firstNetworkId, includeBodies: true }) : "";
    const selected = await browserSelect({ targetLabel: "Course", value: "database" });
    const download = await browserClick({ selector: "#download", expectDownload: true, downloadName: "self-test-download.txt" });
    const downloads = await browserDownloads({ maxItems: 5 });
    const click = await browserClick({ selector: "#next-step" });
    await browserClick({ selector: "#console-error" });
    const consoleReport = await browserConsole({ levels: ["log", "error"], maxEntries: 5 });
    const clickState = await browserEvaluate({ script: "Boolean(document.querySelector('#done'))" });
    const scrolled = await browserScroll({ direction: "bottom", pixels: 800 });
    const scrolledState = await browserEvaluate({ script: "window.scrollY > 0" });
    await browserScroll({ direction: "top", pixels: 800 });
    const popup = await browserClick({ selector: "#open-popup", newPageTimeoutMs: 3000 });
    const popupState = await browserEvaluate({ script: "document.body.innerText" });
    const pages = await browserPages();
    const cdpCandidates = browserExecutableCandidates("auto");
    let cdpLaunch = "skipped: no Chrome/Edge executable found";
    let cdpStatus = "skipped";
    if (cdpCandidates.length) {
      cdpLaunch = await browserSession({
        action: "launch_cdp",
        browser: "auto",
        visible: false,
        profileName: "self-test-cdp",
        url: `http://127.0.0.1:${serverPort}/`,
        startupTimeoutMs: 20000
      });
      cdpStatus = await browserSession({ action: "status" });
    }
    return {
      server: `${SERVER_NAME}@${SERVER_VERSION}`,
      root: ROOT,
      tools: tools.map((tool) => tool.name),
      opened: view.includes("Navigator test page"),
      sessionSaved: savedSession.includes("Saved browser storage state"),
      sessionLoaded: loadedSession.includes("Loaded browser storage state") && loadedStorage.includes("ok"),
      sessionStatus: sessionStatus.includes("Browser session:"),
      foundText: find.includes("Database") && find.includes("[find-"),
      extractedTable: table.includes("Course scores") && table.includes("Database") && table.includes("| Course | Score |"),
      extractedLinks: links.includes("[link-") && links.includes("/docs/start"),
      extractedForms: forms.includes("[form-") && forms.includes("csrf-like") && forms.includes("[field-"),
      hovered: hover.includes("Hover panel ready"),
      asserted: asserted.includes("PASS"),
      reloaded: reloaded.includes("Navigator test page"),
      uploaded: upload.includes("Uploaded files: 1"),
      elementScreenshot: elementShot.includes("Element screenshot:") && fs.existsSync(elementShot.replace(/^Element screenshot:\s*/, "").trim()),
      securitySnapshot: securitySnapshot.includes("browser security snapshot") && securitySnapshot.includes("csrf_token"),
      dialogHandled: armedDialog.includes("Dialog handler armed") && promptResult.includes("accepted prompt"),
      evaluated: evalResult.includes("Navigator Test"),
      fetchedInPage: fetchResult.includes("self-test"),
      networkWaited: waitedNetwork.includes("Matched network entry") && waitedNetwork.includes("/api/self-test"),
      networkCaptured: network.includes("/api/self-test"),
      networkBodyCaptured: network.includes("source") && network.includes("self-test"),
      networkDetailRead: networkDetail.includes("\"request\"") && networkDetail.includes("\"response\""),
      selectedOption: selected.includes("Database"),
      scrolled: scrolled.includes("Scroll:") && scrolledState.includes("Evaluation result"),
      downloadCaptured: download.includes("Download:") && fs.existsSync(download.match(/Download:\s*(.+)/)?.[1]?.trim() || ""),
      downloadsListed: downloads.includes("[d") && downloads.includes("self-test-download.txt"),
      clicked: click.includes("Directory expanded") || clickState.includes("true"),
      consoleRead: consoleReport.includes("next step clicked") && consoleReport.includes("self test console error"),
      popupSwitched: popup.includes("Popup content ready") || popupState.includes("Popup content ready"),
      pagesListed: pages.includes("[p1]") && pages.includes("[p2]"),
      cdpLaunch: cdpCandidates.length ? cdpLaunch.includes("CDP") && cdpStatus.includes("Browser session: cdp") : true,
      cdpLaunchDetail: cdpCandidates.length ? "tested" : cdpLaunch
    };
  } finally {
    await browserClose();
    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }
  }
}

if (process.argv.includes("--self-test")) {
  selfTest()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    })
    .catch((error) => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 1;
    });
} else {
  let queue = Promise.resolve();
  const parse = createStdioParser((message) => {
    queue = queue.then(() => handle(message)).catch((error) => {
      errorResponse(message && message.id !== undefined ? message.id : null, -32603, error.message);
    });
  });
  process.stdin.on("data", parse);
  // Drain any in-flight request before exiting so a close mid-request keeps its reply.
  process.stdin.on("end", () => { Promise.resolve(queue).then(() => process.exit(0)); });
}
