import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, extname, join } from "node:path"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

const require = createRequire(import.meta.url)
// Resolve our direct dependency so no globally installed CLI is required.
const playwrightCli = join(dirname(require.resolve("@playwright/cli/package.json")), "playwright-cli.js")
const globalCommands = new Set(["install", "install-browser"])
const restrictedCommands = new Set(["attach", "close-all", "kill-all", "list", "show"])
const sessionName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const playwrightConfigDirectory = join(tmpdir(), `brandobot-playwright-${process.pid}`)
const playwrightConfig = join(playwrightConfigDirectory, "cli.config.json")

export function defaultBrowserCommand(url: string, platform = process.platform, environment = process.env) {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http: and https: URLs can be opened in the default browser.")
  }

  if (platform === "darwin") return ["open", parsed.href]
  if (platform === "win32") return ["explorer.exe", parsed.href]
  if (platform === "linux") {
    if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) {
      throw new Error("Cannot open the default browser from a headless Linux environment.")
    }
    return ["xdg-open", parsed.href]
  }

  throw new Error(`Opening the default browser is not supported on ${platform}.`)
}

function commandName(args: string[]) {
  for (const arg of args) {
    if (arg.startsWith("-s") || arg.startsWith("--session")) {
      throw new Error("Use the browser tool's session argument instead of Playwright CLI session flags.")
    }
    if (
      arg === "--config" ||
      arg.startsWith("--config=") ||
      arg === "--profile" ||
      arg.startsWith("--profile=") ||
      arg === "--persistent" ||
      arg.startsWith("--persistent=") ||
      arg === "--cdp" ||
      arg.startsWith("--cdp=") ||
      arg === "--endpoint" ||
      arg.startsWith("--endpoint=") ||
      arg === "--extension" ||
      arg.startsWith("--extension=")
    ) {
      throw new Error(`${arg.split("=")[0]} is not available because it can access external browser state.`)
    }
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "--version")) return
  if (!args[0] || args[0].startsWith("-")) {
    throw new Error("Pass the Playwright CLI command as the first args token.")
  }
  return args[0]
}

function artifactFilename(command: string | undefined, args: string[]) {
  if (command === "video-start") return args[1]
  if (command !== "screenshot") return
  const filename = args.find((arg) => arg.startsWith("--filename="))
  if (filename) return filename.slice("--filename=".length)
  const filenameIndex = args.indexOf("--filename")
  return filenameIndex === -1 ? undefined : args[filenameIndex + 1]
}

function timestampedArtifactFilename(filename: string) {
  if (/-\d{8}-\d{9}(?=\.[^/\\]+$|$)/.test(filename)) return filename
  const timestamp = new Date().toISOString().replace(/\D/g, "")
  const extension = extname(filename)
  return `${filename.slice(0, extension ? -extension.length : undefined)}-${timestamp.slice(0, 8)}-${timestamp.slice(8)}${extension}`
}

function timestampedArtifactArgs(command: string | undefined, args: string[]) {
  const filename = artifactFilename(command, args)
  if (!filename) return args
  const timestampedFilename = timestampedArtifactFilename(filename)
  if (command === "video-start") return [args[0], timestampedFilename, ...args.slice(2)]
  return args.map((arg, index) => {
    if (arg.startsWith("--filename=")) return `--filename=${timestampedFilename}`
    return arg === filename && args[index - 1] === "--filename" ? timestampedFilename : arg
  })
}

function requiresArtifactDirectory(command: string | undefined, args: string[]) {
  if (command !== "screenshot" && command !== "video-start") return
  const filename = artifactFilename(command, args)
  if (filename?.includes("/") || filename?.includes("\\")) return
  throw new Error(`Ask the user where to store the ${command === "screenshot" ? "screenshot" : "video"}, then provide a filename with that directory.`)
}

function derivedSessionName(sessionID: string, session?: string) {
  return `brandobot-${createHash("sha256").update(`${sessionID}:${session ?? ""}`).digest("hex").slice(0, 54)}`
}

export function playwrightArgs(args: string[], sessionID: string, session?: string) {
  const command = commandName(args)
  const timestampedArgs = timestampedArtifactArgs(command, args)
  requiresArtifactDirectory(command, timestampedArgs)
  if (command && restrictedCommands.has(command)) {
    throw new Error(`${command} is not available because it can access other Playwright sessions.`)
  }
  if (!command || globalCommands.has(command)) return timestampedArgs
  if (session) {
    if (!sessionName.test(session)) throw new Error("Playwright session names may contain only letters, numbers, hyphens, and underscores.")
    return [`-s=${derivedSessionName(sessionID, session)}`, ...timestampedArgs]
  }
  return [`-s=${derivedSessionName(sessionID)}`, ...timestampedArgs]
}

async function execute(name: string, command: string[], context: ToolContext, environment = process.env) {
  // Use argv directly rather than a shell to preserve argument boundaries.
  const process = Bun.spawn({
    cmd: command,
    cwd: context.directory,
    env: environment,
    signal: context.abort,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  // Preserve CLI snapshots on success and diagnostics when the command fails.
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")

  if (exitCode !== 0) {
    throw new Error(`${name} exited with status ${exitCode}${output ? `:\n${output}` : ""}`)
  }

  return output
}

export function playwrightEnvironment(source = process.env) {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("PLAYWRIGHT_MCP_")))
  environment.PLAYWRIGHT_MCP_CONFIG = playwrightConfig
  environment.PLAYWRIGHT_MCP_ISOLATED = "true"
  environment.PWTEST_CLI_GLOBAL_CONFIG = playwrightConfigDirectory
  return environment
}

export function playwrightCommand(args: string[]) {
  const command = args[0]?.startsWith("-s=") ? args[1] : args[0]
  return command === "open" ? [playwrightCli, "--config", playwrightConfig, ...args] : [playwrightCli, ...args]
}

export function playwrightOutputDirectory(args: string[]) {
  const session = args.find((arg) => arg.startsWith("-s="))?.slice(3) ?? "global"
  return join(playwrightConfigDirectory, "artifacts", session)
}

async function executePlaywright(args: string[], context: ToolContext) {
  // This prevents project config and inherited Playwright settings from attaching to shared browser state.
  const outputDirectory = playwrightOutputDirectory(args)
  await mkdir(playwrightConfigDirectory, { recursive: true })
  await Bun.write(playwrightConfig, JSON.stringify({ browser: { isolated: true } }))
  const environment = playwrightEnvironment()
  environment.PLAYWRIGHT_MCP_OUTPUT_DIR = outputDirectory
  return execute("playwright-cli", playwrightCommand(args), context, environment)
}

const browserGuidance = `## Browser routing
- Use open_url when the user explicitly asks to open an http(s) URL in the OpenCode host's default browser. Do not use it for testing or page inspection.
- Use browser for browser testing, navigation, interaction, DOM or accessibility inspection, screenshots, visual checks, storage, tracing, or other automated browser work. Do not attach to an existing browser or use external browser profiles/configuration.
- For browser, open an absolute URL with --browser=chromium, then call snapshot before using element refs. Take another snapshot after page-changing actions.
- Use webfetch to read, summarize, or extract content from a URL without browser automation.
- Before taking a screenshot or recording video, ask where it should be stored unless the user specified a directory. Use "--filename artifacts/name.png" for screenshots or "video-start artifacts/name.webm" for video; a UTC timestamp is appended automatically.
- Ask a brief clarification only when a request mixes these intents or is ambiguous. Use browser with --headed only when the user explicitly requests a visible Playwright-controlled browser.`

const Brandobot: Plugin = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(browserGuidance)
  },
  tool: {
    open_url: tool({
      description:
        "Open an http(s) URL in the OpenCode host's platform-default browser. Use only for an explicit request to open a URL for the user, not for browser testing, inspection, or automation.",
      args: {
        url: tool.schema.string().url().describe("The http(s) URL to open in the user's default browser."),
      },
      async execute(input, context) {
        const command = defaultBrowserCommand(input.url)
        await execute("default browser", command, context)
        return `Opened ${new URL(input.url).href} in the default browser.`
      },
    }),
    // A single generic tool exposes the Playwright CLI automation surface.
    browser: tool({
      description:
        "Run a Playwright CLI command for automated browser testing and inspection. Pass each token after playwright-cli in args, without a shell or the executable name. For page work, open with --browser=chromium and call snapshot to obtain element refs before interacting. Sessions are isolated per OpenCode conversation unless session is set explicitly.",
      args: {
        args: tool.schema
          .array(tool.schema.string())
          .min(1)
          .describe('Playwright CLI argv tokens, for example ["open", "https://example.com"] or ["click", "e12"].'),
        session: tool.schema
          .string()
          .regex(sessionName, "Use letters, numbers, hyphens, and underscores only.")
          .optional()
          .describe("Optional browser label scoped to the current OpenCode conversation."),
      },
      async execute(input, context) {
        // Playwright CLI namespaces browser state by an optional named session.
        const args = playwrightArgs(input.args, context.sessionID, input.session)
        return executePlaywright(args, context)
      },
    }),
  },
})

export default Brandobot
