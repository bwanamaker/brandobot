# brandobot

An [OpenCode](https://opencode.ai) plugin that controls a browser through [Playwright CLI](https://playwright.dev/agent-cli/introduction).

## Install

Add the published package to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["brandobot"]
}
```

Restart OpenCode after changing its configuration. OpenCode installs the package and its Playwright CLI dependency when it starts.

Playwright CLI requires Node.js 18 or later. Install its managed browsers before the first browser session with `browser({ args: ["install-browser"] })`. On Linux, pass `--with-deps` when system browser dependencies also need installing. The default CLI browser is a system Chrome installation; pass `--browser=chromium` to use Playwright-managed Chromium.

## Browser Tool

The plugin adds a `browser` tool with these arguments:

| Argument | Required | Description |
| --- | --- | --- |
| `args` | Yes | Each token after `playwright-cli`; do not include the executable name. |
| `session` | No | A named isolated Playwright CLI session. |

Use the tool in the same order as the CLI. Start with `open`, use the element refs emitted in page snapshots for interactions, and close the session when finished.

```text
browser({ args: ["open", "https://demo.playwright.dev/todomvc", "--browser=chromium"] })
browser({ args: ["type", "Buy groceries"] })
browser({ args: ["press", "Enter"] })
browser({ args: ["snapshot"] })
browser({ args: ["screenshot"] })
browser({ args: ["close"] })
```

Named sessions retain their own browser, navigation history, cookies, and storage between tool calls:

```text
browser({ session: "admin", args: ["open", "https://example.com", "--browser=chromium", "--persistent"] })
browser({ session: "admin", args: ["goto", "/settings"] })
browser({ session: "admin", args: ["close"] })
```

The browser runs headlessly by default. Pass `--headed` to `open` to display it, or place Playwright CLI configuration in `.playwright/cli.config.json` in the project directory.

To require approval before browser operations, configure the OpenCode permission by tool name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "browser": "ask"
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

The test runs `playwright-cli --help` through the plugin tool and does not launch or download a browser.
