import { createHash } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, opendir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, extname, isAbsolute, join } from "node:path"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

const require = createRequire(import.meta.url)
// Resolve our direct dependency so no globally installed CLI is required.
const playwrightCli = join(dirname(require.resolve("@playwright/cli/package.json")), "playwright-cli.js")
const playwrightTestPackage = require.resolve("@playwright/test/package.json")
const playwrightTestDirectory = dirname(playwrightTestPackage)
const playwrightTestCli = join(playwrightTestDirectory, "cli.js")
const testTimeout = 30_000
const testGlobalTimeout = 120_000
const testProcessTimeout = testGlobalTimeout + 15_000
const browserInstallTimeout = 10 * 60_000
const outputLimit = 1_000_000
const artifactLimit = 100
const artifactEntryLimit = 200
const cancellationMessage = "Brandobot operation cancelled."
const globalCommands = new Set(["install", "install-browser"])
const restrictedCommands = new Set(["attach", "close-all", "kill-all", "list", "show"])
const sessionName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const playwrightConfigDirectory = join(tmpdir(), `brandobot-playwright-${process.pid}`)
const playwrightConfig = join(playwrightConfigDirectory, "cli.config.json")
const cacheRoot =
  process.platform === "win32"
    ? process.env.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA)
      ? process.env.LOCALAPPDATA
      : join(homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)
        ? process.env.XDG_CACHE_HOME
        : join(homedir(), ".cache")
const brandobotBrowserCache = join(cacheRoot, "brandobot", "playwright")
type ChromiumInstallation = {
  controller: AbortController
  done: boolean
  promise: Promise<void>
  waiters: number
}
let chromiumInstallation: ChromiumInstallation | undefined

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

type ProcessResult = {
  exitCode: number
  output: string
  timedOut: boolean
  cancelled: boolean
}

async function readOutput(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let output = ""
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (size < outputLimit) {
      const chunk = value.slice(0, outputLimit - size)
      output += decoder.decode(chunk, { stream: true })
      size += chunk.length
      truncated ||= chunk.length !== value.length
    } else {
      truncated = true
    }
  }
  output += decoder.decode()
  return `${output}${truncated ? "\n[output truncated]" : ""}`
}

async function executeProcess(
  command: string[],
  context: ToolContext,
  environment = process.env,
  timeout?: number,
): Promise<ProcessResult> {
  const controller = new AbortController()
  let cancelled = context.abort.aborted
  const abort = () => {
    cancelled = true
    controller.abort()
  }
  if (context.abort.aborted) controller.abort()
  else context.abort.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = timeout
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeout)
    : undefined

  // Use argv directly rather than a shell to preserve argument boundaries.
  try {
    const process = Bun.spawn({
      cmd: command,
      cwd: context.directory,
      env: environment,
      signal: controller.signal,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      readOutput(process.stdout),
      readOutput(process.stderr),
      process.exited,
    ])
    // Preserve CLI snapshots on success and diagnostics when the command fails.
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    return { exitCode, output, timedOut, cancelled }
  } catch (error) {
    if (timedOut || cancelled) return { exitCode: 1, output: "", timedOut, cancelled }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    context.abort.removeEventListener("abort", abort)
  }
}

async function execute(name: string, command: string[], context: ToolContext, environment = process.env) {
  const result = await executeProcess(command, context, environment)

  if (result.cancelled) throw new Error(`${name} was cancelled.`)
  if (result.exitCode !== 0) {
    throw new Error(`${name} exited with status ${result.exitCode}${result.output ? `:\n${result.output}` : ""}`)
  }

  return result.output
}

export function playwrightEnvironment(source = process.env) {
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("PLAYWRIGHT_MCP_")))
  environment.PLAYWRIGHT_MCP_CONFIG = playwrightConfig
  environment.PLAYWRIGHT_MCP_ISOLATED = "true"
  environment.PLAYWRIGHT_BROWSERS_PATH = brandobotBrowserCache
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

export function chromiumRequested(args: string[]) {
  return (
    args[0] === "open" &&
    (args.includes("--browser=chromium") || args.some((arg, index) => arg === "--browser" && args[index + 1] === "chromium"))
  )
}

async function chromiumInstalled() {
  await mkdir(brandobotBrowserCache, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(brandobotBrowserCache, 0o700)
  const inheritedBrowserCache = process.env.PLAYWRIGHT_BROWSERS_PATH
  process.env.PLAYWRIGHT_BROWSERS_PATH = brandobotBrowserCache
  const playwright = require("@playwright/test") as { chromium: { executablePath(): string } }
  const executablePath = playwright.chromium.executablePath()
  if (inheritedBrowserCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = inheritedBrowserCache
  try {
    await access(executablePath)
    return true
  } catch {
    return false
  }
}

async function installChromium(context: ToolContext) {
  context.metadata({
    title: "Installing Brandobot Chromium",
    metadata: { browser: "chromium" },
  })
  const result = await executeProcess(
    [playwrightTestCli, "install", "chromium"],
    context,
    playwrightTestEnvironment(),
    browserInstallTimeout,
  )
  if (result.exitCode !== 0) {
    const reason = result.timedOut ? " timed out" : ` exited with status ${result.exitCode}`
    throw new Error(`Brandobot Chromium installation${reason}${result.output ? `:\n${result.output}` : ""}`)
  }
}

function waitForAbort<T>(value: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new Error(cancellationMessage))
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(new Error(cancellationMessage))
    }
    signal.addEventListener("abort", abort, { once: true })
    value.then(
      (result) => {
        signal.removeEventListener("abort", abort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

async function ensureChromium(context: ToolContext) {
  if (context.abort.aborted) throw new Error(cancellationMessage)
  if (await chromiumInstalled()) return
  if (chromiumInstallation?.controller.signal.aborted) {
    const interruptedInstallation = chromiumInstallation
    try {
      await waitForAbort(interruptedInstallation.promise, context.abort)
    } catch {
      if (context.abort.aborted) throw new Error(cancellationMessage)
    }
    if (chromiumInstallation === interruptedInstallation) chromiumInstallation = undefined
  }
  if (!chromiumInstallation) {
    const controller = new AbortController()
    const installation: ChromiumInstallation = {
      controller,
      done: false,
      promise: Promise.resolve(),
      waiters: 0,
    }
    const installationContext = { ...context, abort: controller.signal }
    installation.promise = installChromium(installationContext).finally(() => {
      installation.done = true
      if (chromiumInstallation === installation) chromiumInstallation = undefined
    })
    chromiumInstallation = installation
    void installation.promise.catch(() => {})
  } else {
    context.metadata({ title: "Waiting for Brandobot Chromium" })
  }
  const installation = chromiumInstallation
  installation.waiters++
  try {
    await waitForAbort(installation.promise, context.abort)
  } finally {
    installation.waiters--
    if (!installation.done && installation.waiters === 0) installation.controller.abort()
  }
}

export async function brandobotPlaywrightTestVersion() {
  const metadata = JSON.parse(await readFile(playwrightTestPackage, "utf8")) as { version?: unknown }
  if (typeof metadata.version !== "string") throw new Error("Could not read Brandobot's @playwright/test version.")
  return metadata.version
}

export function ephemeralTestConfig(outputDirectory: string) {
  return `import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  outputDir: ${JSON.stringify(outputDirectory)},
  timeout: ${testTimeout},
  globalTimeout: ${testGlobalTimeout},
  workers: 1,
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
})
`
}

export function playwrightTestEnvironment(source = process.env, reportFile?: string) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([key]) => {
      return !key.startsWith("PLAYWRIGHT_") && !key.startsWith("PWTEST_") && !key.startsWith("PW_TEST_")
    }),
  )
  environment.PLAYWRIGHT_BROWSERS_PATH = brandobotBrowserCache
  if (reportFile) environment.PLAYWRIGHT_JSON_OUTPUT_FILE = reportFile
  return environment
}

type ReportSummary = {
  passed: number
  failed: number
  skipped: number
  retries: number
  testNames: string[]
  failures: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown) {
  return typeof value === "number" ? value : 0
}

function errorMessage(value: unknown) {
  if (typeof value === "string") return value
  const error = asRecord(value)
  return typeof error?.message === "string" ? error.message : undefined
}

export function summarizePlaywrightReport(value: unknown): ReportSummary | undefined {
  const report = asRecord(value)
  const stats = asRecord(report?.stats)
  if (!report || !stats) return

  const testNames: string[] = []
  const failures: string[] = asArray(report.errors).flatMap((error) => {
    const message = errorMessage(error)
    return message ? [message] : []
  })
  let retries = 0

  const visitSuite = (value: unknown, titles: string[]) => {
    const suite = asRecord(value)
    if (!suite) return
    const title = typeof suite.title === "string" ? suite.title : undefined
    const nextTitles = title ? [...titles, title] : titles
    for (const specValue of asArray(suite.specs)) {
      const spec = asRecord(specValue)
      if (!spec) continue
      const specTitle = typeof spec.title === "string" ? spec.title : "Unnamed test"
      const name = [...nextTitles, specTitle].join(" > ")
      testNames.push(name)
      for (const testValue of asArray(spec.tests)) {
        const test = asRecord(testValue)
        const results = asArray(test?.results)
        retries += Math.max(0, results.length - 1)
        for (const resultValue of results) {
          const result = asRecord(resultValue)
          for (const error of asArray(result?.errors)) {
            const message = errorMessage(error)
            if (message) failures.push(`${name}: ${message}`)
          }
        }
      }
    }
    for (const child of asArray(suite.suites)) visitSuite(child, nextTitles)
  }

  for (const suite of asArray(report.suites)) visitSuite(suite, [])
  return {
    passed: asNumber(stats.expected) + asNumber(stats.flaky),
    failed: asNumber(stats.unexpected),
    skipped: asNumber(stats.skipped),
    retries,
    testNames,
    failures: [...new Set(failures)],
  }
}

async function artifactPaths(directory: string) {
  try {
    const paths: string[] = []
    const directories = [directory]
    let entries = 0
    while (directories.length && paths.length < artifactLimit && entries < artifactEntryLimit) {
      const current = directories.pop()!
      for await (const entry of await opendir(current)) {
        entries++
        const path = join(current, entry.name)
        if (entry.isDirectory()) directories.push(path)
        else paths.push(path)
        if (paths.length === artifactLimit || entries === artifactEntryLimit) break
      }
    }
    return { paths, truncated: directories.length > 0 || paths.length === artifactLimit || entries === artifactEntryLimit }
  } catch {
    return { paths: [], truncated: false }
  }
}

async function readPlaywrightReport(reportFile: string) {
  try {
    if ((await stat(reportFile)).size > outputLimit) return { error: "The JSON report exceeded the 1MB limit." }
    return { report: JSON.parse(await readFile(reportFile, "utf8")) }
  } catch {
    return { error: "The JSON report was unavailable or invalid." }
  }
}

async function createEphemeralTest(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "brandobot-ui-test-"))
  const packageDirectory = join(directory, "node_modules", "@playwright")
  await mkdir(packageDirectory, { recursive: true })
  await symlink(playwrightTestDirectory, join(packageDirectory, "test"), process.platform === "win32" ? "junction" : "dir")
  const testFile = join(directory, "brandobot.spec.ts")
  const outputDirectory = join(directory, "artifacts")
  const reportFile = join(directory, "report.json")
  const configFile = join(directory, "playwright.config.ts")
  await Promise.all([
    writeFile(testFile, source),
    writeFile(configFile, ephemeralTestConfig(outputDirectory)),
  ])
  return { directory, testFile, outputDirectory, configFile, reportFile }
}

async function executeEphemeralTest(source: string, context: ToolContext) {
  try {
    await ensureChromium(context)
  } catch (error) {
    if (error instanceof Error && error.message === cancellationMessage) return cancelledTestResult()
    throw error
  }
  context.metadata({ title: "Running Brandobot UI test" })
  const workspace = await createEphemeralTest(source)
  const startedAt = Date.now()
  const result = await executeProcess(
    [playwrightTestCli, "test", "--config", workspace.configFile, workspace.testFile, "--reporter=json"],
    { ...context, directory: workspace.directory },
    playwrightTestEnvironment(process.env, workspace.reportFile),
    testProcessTimeout,
  )
  const report = await readPlaywrightReport(workspace.reportFile)
  const summary = summarizePlaywrightReport("report" in report ? report.report : undefined)
  const reportError = "error" in report && typeof report.error === "string" ? report.error : undefined
  const artifacts = await artifactPaths(workspace.outputDirectory)
  const version = await brandobotPlaywrightTestVersion()
  const status = result.cancelled
    ? "cancelled"
    : result.timedOut
      ? "timed out"
      : result.exitCode !== 0
        ? "failed"
        : !summary
          ? "inconclusive"
          : summary.passed === 0
            ? "skipped"
            : "passed"
  const passed = status === "passed"
  const counts = summary
    ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.retries} retries`
    : "Test result details were unavailable."
  const lines = [
    `${passed ? "PASS" : status === "skipped" ? "SKIPPED" : status === "cancelled" ? "CANCELLED" : status === "inconclusive" ? "INCONCLUSIVE" : "FAIL"} - Brandobot ephemeral validation`,
    `Runner: Brandobot @playwright/test ${version}`,
    `Result: ${counts}`,
    `Duration: ${Date.now() - startedAt}ms`,
    "This test was not saved to the project or validated for CI.",
  ]
  if (summary?.testNames.length) lines.push(`Tests: ${summary.testNames.join(", ")}`)
  if (summary?.failures.length) lines.push(`Failures:\n${summary.failures.slice(0, 5).map((failure) => `- ${failure}`).join("\n")}`)
  if (status === "cancelled") lines.push("The operation was cancelled.")
  if (status === "timed out") lines.push(`The test process exceeded its ${testProcessTimeout}ms limit.`)
  if (status === "inconclusive") lines.push(reportError ?? "The JSON report did not contain test results.")
  if (!summary && result.output) lines.push(`Diagnostics:\n${result.output}`)
  if (artifacts.paths.length) lines.push(`Artifacts:\n${artifacts.paths.map((artifact) => `- ${artifact}`).join("\n")}`)
  if (artifacts.truncated) lines.push(`Artifact list truncated after ${artifactLimit} files or ${artifactEntryLimit} entries.`)

  return {
    title: `UI test ${status}`,
    output: lines.join("\n"),
    metadata: {
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      duration: Date.now() - startedAt,
      runner: "brandobot",
      playwrightVersion: version,
      ...summary,
      artifacts: artifacts.paths,
      artifactsTruncated: artifacts.truncated,
    },
  }
}

async function cancelledTestResult() {
  const version = await brandobotPlaywrightTestVersion()
  return {
    title: "UI test cancelled",
    output: `CANCELLED - Brandobot ephemeral validation\nRunner: Brandobot @playwright/test ${version}\nThe operation was cancelled.`,
    metadata: {
      status: "cancelled",
      runner: "brandobot",
      playwrightVersion: version,
    },
  }
}

const browserGuidance = `## Browser routing
- Use open_url when the user explicitly asks to open an http(s) URL in the OpenCode host's default browser. Do not use it for testing or page inspection.
- Use browser for browser testing, navigation, interaction, DOM or accessibility inspection, screenshots, visual checks, storage, tracing, or other automated browser work. Do not attach to an existing browser or use external browser profiles/configuration.
- For browser, open an absolute URL with --browser=chromium, then call snapshot before using element refs. Take another snapshot after page-changing actions.
- Use webfetch to read, summarize, or extract content from a URL without browser automation.
- Before taking a screenshot or recording video without a destination directory, MUST call the question tool before any browser command or text response. Set header to "Save location" and offer these options in order: label "artifacts/", description "Save this capture in the workspace artifacts directory."; label "artifacts/ (Always)", description "Save this and future captures in this conversation in the workspace artifacts directory." If the user selects the second option, remember artifacts/ as the destination for later screenshots and videos in this conversation and do not ask again. Do not ask this question in plain text and do not add a custom option: the question tool provides its automatic custom-answer choice. Use "--filename artifacts/name.png" for screenshots or "video-start artifacts/name.webm" for video after the user answers; a UTC timestamp is appended automatically.
- Ask a brief clarification only when a request mixes these intents or is ambiguous. Use browser with --headed only when the user explicitly requests a visible Playwright-controlled browser.`

const uiTestingGuidance = `## UI test routing
- Use run_ui_test for a temporary, focused Playwright Test check. Pass a complete TypeScript spec that imports from @playwright/test.
- Inspect the UI before authoring selectors. Prefer getByRole and getByLabel, auto-waiting assertions, and observable user behavior; do not use arbitrary sleeps.
- run_ui_test creates no project files itself, but its source is local code execution. Its result is Brandobot-only evidence, not CI validation.
- When the user asks to save a test, use normal project authoring and test conventions instead of run_ui_test.`

const Brandobot: Plugin = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(browserGuidance)
    output.system.push(uiTestingGuidance)
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
        if (chromiumRequested(input.args)) await ensureChromium(context)
        const args = playwrightArgs(input.args, context.sessionID, input.session)
        return executePlaywright(args, context)
      },
    }),
    run_ui_test: tool({
      description:
        "Run a complete temporary TypeScript Playwright Test spec with Brandobot's bundled runner. The test is written only to an isolated temporary directory and is not project or CI validation.",
      args: {
        source: tool.schema
          .string()
          .min(1)
          .max(100_000)
          .describe('Complete TypeScript Playwright spec source, for example: import { expect, test } from "@playwright/test"; test("home", async ({ page }) => { await page.goto("https://example.com"); await expect(page).toHaveTitle(/Example/); });'),
      },
      async execute(input, context) {
        return executeEphemeralTest(input.source, context)
      },
    }),
  },
})

export default Brandobot
