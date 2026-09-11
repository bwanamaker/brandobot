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

Playwright CLI requires Node.js 20 or later. Install its managed browsers before the first browser session with `browser({ args: ["install-browser"] })`. On Linux, pass `--with-deps` when system browser dependencies also need installing. The default CLI browser is a system Chrome installation; pass `--browser=chromium` to use Playwright-managed Chromium.

## URL Routing

Brandobot gives the agent routing guidance for selecting the appropriate tool:

| Request | Tool |
| --- | --- |
| Open a URL in the OpenCode host's browser | `open_url` |
| Test, inspect, navigate, interact with, or screenshot a page | `browser` |
| Read, summarize, or extract content from a URL | OpenCode `webfetch` |

For requests that mix these intents or are unclear, the guidance instructs the agent to ask a short clarifying question.

`open_url` launches the OpenCode host's platform-default browser, not a Playwright browser. When OpenCode runs locally, this is normally the user's default browser:

```text
open_url({ url: "https://www.brandonwanamaker.com" })
```

It supports only `http` and `https` URLs and returns an error on unsupported platforms or headless Linux environments.

## Browser Tool

The plugin adds a `browser` tool with these arguments:

| Argument | Required | Description |
| --- | --- | --- |
| `args` | Yes | Each token after `playwright-cli`; do not include the executable name. |
| `session` | No | A labeled browser isolated to the current OpenCode conversation. |

Use the tool in the same order as the CLI. Start with `open --browser=chromium`, call `snapshot` to obtain element refs, use those refs for interactions, and close the session when finished. Browser sessions are isolated automatically for each OpenCode conversation. Set `session` to create a separate labeled browser within that same conversation; labels never share state across conversations. Attaching to an existing browser, persistent profiles, external endpoints, and custom Playwright configuration are not supported.

```text
browser({ args: ["open", "https://demo.playwright.dev/todomvc", "--browser=chromium"] })
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
npm pack --dry-run
```

The test runs `playwright-cli --help` through the plugin tool and does not launch or download a browser.
