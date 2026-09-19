# @bwanamaker/brandobot

An [OpenCode](https://opencode.ai) plugin that controls a browser through [Playwright CLI](https://playwright.dev/agent-cli/introduction).

View the [NPM](https://www.npmjs.com/package/@bwanamaker/brandobot) package.

## Install

Add the published package to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@bwanamaker/brandobot"]
}
```

Restart OpenCode after changing its configuration. OpenCode installs the package and its Playwright CLI dependency when it starts.

Node.js `^22.22.2 || ^24.15.0 || >=26.0.0` is required. Brandobot downloads managed Chromium before a Chromium browser operation or temporary UI test needs it. Chromium installation is shared across requests, so cancelling one request does not cancel an already-started download. On Linux, install missing system browser dependencies separately; Brandobot does not run privileged dependency installation. The browser CLI defaults to a system Chrome installation, so pass `--browser=chromium` to use managed Chromium.

## Choosing Tools

Brandobot guides the agent to select the appropriate tool:

| Request | Tool |
| --- | --- |
| Open a URL in the OpenCode host's browser | `open_url` |
| Test, inspect, navigate, interact with, or screenshot a page | `browser` |
| Run a temporary Playwright Test check | `run_ui_test` |
| Read, summarize, or extract content from a URL | OpenCode `webfetch` |

Use `open_url` only when explicitly asked to open an `http` or `https` URL in the OpenCode host's default browser. For mixed or unclear requests, Brandobot asks a short clarifying question.

## Browser Tool

The plugin adds a `browser` tool with these arguments:

| Argument | Required | Description |
| --- | --- | --- |
| `args` | Yes | Each token after `playwright-cli`; do not include the executable name. |
| `session` | No | A labeled browser isolated to the current OpenCode conversation. |

Use the tool in the same order as the CLI. Start with `open --browser=chromium`, call `snapshot` when you need element refs, refresh the snapshot after page-changing actions, and close the session when finished. The `type` command writes to the focused field; use snapshot refs for targeted actions such as `click`. Browser sessions are isolated automatically for each OpenCode conversation. Set `session` to create a separate labeled browser within that same conversation; labels never share state across conversations. Attaching to an existing browser, persistent profiles, external endpoints, and custom Playwright configuration are not supported.

```text
browser({ args: ["open", "https://demo.playwright.dev/todomvc", "--browser=chromium"] })
browser({ args: ["snapshot"] })
browser({ args: ["type", "Buy groceries"] })
browser({ args: ["press", "Enter"] })
browser({ args: ["snapshot"] })
browser({ args: ["screenshot", "--filename", "artifacts/todo.png"] })
browser({ args: ["close"] })
```

Screenshot and video filenames receive a UTC timestamp automatically, such as `artifacts/todo-20260905-203834123.png`, to prevent overwriting prior captures.

Labeled sessions retain their own browser, navigation history, cookies, and storage between tool calls within the current OpenCode conversation:

```text
browser({ session: "admin", args: ["open", "https://example.com", "--browser=chromium"] })
browser({ session: "admin", args: ["goto", "/settings"] })
browser({ session: "admin", args: ["close"] })
```

The browser runs headlessly by default. Pass `--headed` to `open` to display it. Brandobot uses an isolated Playwright configuration and temporary per-session internal output for browser launches.

## Ephemeral UI Tests

`run_ui_test` runs a complete TypeScript Playwright Test spec with Brandobot's bundled `@playwright/test`. Brandobot writes its spec, runner configuration, and evidence only to an OS temporary directory; no project files, dependencies, or CI configuration are changed by the plugin.

```text
run_ui_test({ source: 'import { expect, test } from "@playwright/test"; test("home page", async ({ page }) => { await page.goto("https://example.com"); await expect(page).toHaveTitle(/Example Domain/); });' })
```

The result includes test counts, diagnostics, and temporary trace, screenshot, or video paths. It is Brandobot-only evidence. To save a regression test, ask the agent to write it using the target project's own test conventions and runner.

The supplied source is local code execution. It can access the same machine resources available to the OpenCode process, so require approval for the tool when that boundary matters:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "run_ui_test": "ask"
  }
}
```

To require approval before browser operations, configure the OpenCode permission by tool name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "browser": "ask",
    "open_url": "ask"
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

The test runs `playwright-cli --help` through the plugin tool and does not launch or download a browser.
