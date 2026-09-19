import { createHash, randomUUID } from "node:crypto"
import { access, chmod, mkdir, mkdtemp, opendir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, extname, isAbsolute, join, relative } from "node:path"
import { tool, type Plugin, type PluginModule, type ToolContext } from "@opencode-ai/plugin"

const require = createRequire(import.meta.url)
// Resolve our direct dependency so no globally installed CLI is required.
const playwrightCliPackage = require.resolve("@playwright/cli/package.json")
const playwrightCli = join(dirname(playwrightCliPackage), "playwright-cli.js")
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
const processTerminationGrace = 5_000
const ephemeralWorkspaceDirectory = join(tmpdir(), "brandobot-ui-tests")
const ephemeralWorkspacePrefix = "run-"
const ephemeralWorkspaceActiveFile = ".brandobot-active"
const ephemeralWorkspaceHeartbeat = 60_000
const ephemeralWorkspaceLimit = 20
const ephemeralWorkspaceRetention = 24 * 60 * 60_000
const cancellationMessage = "Brandobot operation cancelled."
const restrictedCommands = new Set(["attach", "close-all", "install", "install-browser", "kill-all", "list", "run-code", "show", "state-load", "state-save"])
const openFlags = new Set(["browser", "device", "headed", "mobile", "persistent", "profile"])
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
let chromiumInstall: Promise<void> | undefined

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
    if (command === "install" || command === "install-browser") {
      throw new Error(`${command} is not available because Brandobot manages browser installation.`)
    }
    if (command === "state-load" || command === "state-save") {
      throw new Error(`${command} is not available because it can access external browser state.`)
    }
    if (command === "run-code") {
      throw new Error(`${command} is not available because it can execute local code.`)
    }
    throw new Error(`${command} is not available because it can access other Playwright sessions.`)
  }
  if (!command) return timestampedArgs
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

function processDescendants(pid: number) {
  try {
    const output = new TextDecoder().decode(Bun.spawnSync({ cmd: ["ps", "-eo", "pid=,ppid="], stdout: "pipe", stderr: "ignore" }).stdout)
    const children = new Map<number, number[]>()
    for (const line of output.split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number)
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
      children.set(parent, [...(children.get(parent) ?? []), child])
    }
    const descendants: number[] = []
    const parents = [pid]
    while (parents.length) {
      for (const child of children.get(parents.pop()!) ?? []) {
        descendants.push(child)
        parents.push(child)
      }
    }
    return descendants
  } catch {
    // Process groups still handle descendants when the platform cannot list processes.
    return []
  }
}

function processesWithToken(token: string) {
  try {
    const output = new TextDecoder().decode(Bun.spawnSync({ cmd: ["ps", "eww", "-eo", "pid=,command="], stdout: "pipe", stderr: "ignore" }).stdout)
    return output
      .split("\n")
      .filter((line) => line.includes(`BRANDOBOT_PROCESS_TOKEN=${token}`))
      .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
      .filter(Number.isInteger)
  } catch {
    // Process groups still handle descendants when the platform cannot inspect environments.
    return []
  }
}

function processTerminationTargets(pid: number, token: string) {
  if (process.platform === "win32") return []
  return [...new Set([...processDescendants(pid), ...processesWithToken(token)])]
}

function terminateProcessTree(pid: number, descendants: number[], signal: NodeJS.Signals) {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync({ cmd: ["taskkill", "/pid", `${pid}`, "/t", "/f"], stdout: "ignore", stderr: "ignore" })
    } else {
      for (const descendant of [...descendants].reverse()) {
        try {
          process.kill(descendant, signal)
        } catch {
          // The process may have exited before its parent was signalled.
        }
      }
      process.kill(-pid, signal)
    }
  } catch {
    // The process may have exited between the cancellation check and the signal.
  }
}

async function executeProcess(
  command: string[],
  context: ToolContext,
  environment = process.env,
  timeout?: number,
): Promise<ProcessResult> {
  if (context.abort.aborted) return { exitCode: 1, output: "", timedOut: false, cancelled: true }

  let cancelled = false
  let child: ReturnType<typeof Bun.spawn> | undefined
  let descendants: number[] = []
  const processToken = randomUUID()
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const terminate = () => {
    if (!child) return
    descendants = processTerminationTargets(child.pid, processToken)
    terminateProcessTree(child.pid, descendants, "SIGTERM")
    if (process.platform !== "win32") {
      forceKill ??= setTimeout(() => {
        descendants = processTerminationTargets(child!.pid, processToken)
        terminateProcessTree(child!.pid, descendants, "SIGKILL")
      }, processTerminationGrace)
    }
  }
  const abort = () => {
    cancelled = true
    terminate()
  }
  context.abort.addEventListener("abort", abort, { once: true })
  let timedOut = false
  const timer = timeout
    ? setTimeout(() => {
        timedOut = true
        terminate()
      }, timeout)
    : undefined

  // Use argv directly rather than a shell to preserve argument boundaries.
  try {
    const process = Bun.spawn({
      cmd: command,
      cwd: context.directory,
      detached: true,
      env: { ...environment, BRANDOBOT_PROCESS_TOKEN: processToken },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    child = process
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
    if (forceKill) {
      clearTimeout(forceKill)
      if (child) {
        descendants = processTerminationTargets(child.pid, processToken)
        terminateProcessTree(child.pid, descendants, "SIGKILL")
      }
    }
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

function isPlaywrightEnvironment(key: string) {
  const name = key.toLowerCase()
  return (
    name === "pwdebug" ||
    name === "npm_config_pwdebug" ||
    name === "npm_package_config_pwdebug" ||
    name.startsWith("playwright_") ||
    name.startsWith("pwtest_") ||
    name.startsWith("pw_test_")
  )
}

export function playwrightEnvironment(source = process.env) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([key]) => !isPlaywrightEnvironment(key)),
  )
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

function chromiumRequested(args: string[]) {
  if (!Array.isArray(args)) return false
  const optionEnd = args.indexOf("--")
  const options = args.slice(1, optionEnd === -1 ? undefined : optionEnd)
  return (
    args[0] === "open" &&
    !options.includes("--help") &&
    !options.includes("-h") &&
    !options.includes("--version") &&
    !options.includes("-v") &&
    (options.includes("--browser=chromium") || options.some((arg, index) => arg === "--browser" && options[index + 1] === "chromium"))
  )
}

function validatePlaywrightFlags(args: string[]) {
  if (args[0] !== "open") return
  for (const arg of args.slice(1)) {
    if (arg === "--") break
    if (!arg.startsWith("-") || arg === "-") continue
    const flag = arg.slice(arg.startsWith("--") ? 2 : 1).split("=")[0].replace(/^no-/, "")
    if (["h", "help", "json", "raw", "v", "version"].includes(flag) || openFlags.has(flag)) continue
    throw new Error(`${arg.split("=")[0]} is not a supported Playwright CLI option.`)
  }
}

async function chromiumInstalled() {
  await mkdir(brandobotBrowserCache, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(brandobotBrowserCache, 0o700)
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "-e", "console.log(require(process.env.BRANDOBOT_PLAYWRIGHT_TEST).chromium.executablePath())"],
      env: {
        ...process.env,
        BRANDOBOT_PLAYWRIGHT_TEST: playwrightTestDirectory,
        PLAYWRIGHT_BROWSERS_PATH: brandobotBrowserCache,
      },
      stderr: "ignore",
      stdout: "pipe",
    })
    const executablePath = new TextDecoder().decode(result.stdout).trim()
    return chromiumInstallationComplete(executablePath)
  } catch {
    return false
  }
}

async function chromiumInstallationComplete(executablePath: string, cacheDirectory = brandobotBrowserCache) {
  const browserDirectory = relative(cacheDirectory, executablePath).split(/[\\/]/)[0]
  if (!browserDirectory || browserDirectory === "..") return false
  try {
    await Promise.all([
      access(executablePath),
      access(join(cacheDirectory, browserDirectory, "INSTALLATION_COMPLETE")),
    ])
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
  // The pre-check is required: addEventListener never fires on an already-aborted signal.
  if (signal.aborted) return Promise.reject(new Error(cancellationMessage))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(cancellationMessage))
    signal.addEventListener("abort", onAbort, { once: true })
    const detach = () => signal.removeEventListener("abort", onAbort)
    value.then(
      (result) => {
        detach()
        resolve(result)
      },
      (error) => {
        detach()
        reject(error)
      },
    )
  })
}

async function ensureChromium(context: ToolContext) {
  if (context.abort.aborted) throw new Error(cancellationMessage)
  if (await chromiumInstalled()) return
  if (chromiumInstall) {
    context.metadata({ title: "Waiting for Brandobot Chromium" })
  } else {
    const install = installChromium({ ...context, abort: new AbortController().signal })
    chromiumInstall = install
    // ponytail: no abort-on-last-waiter; an orphaned install is bounded by browserInstallTimeout
    void install
      .catch(() => {})
      .then(() => {
        if (chromiumInstall === install) chromiumInstall = undefined
      })
  }
  await waitForAbort(chromiumInstall, context.abort)
}

async function brandobotPlaywrightTestVersion() {
  const metadata = JSON.parse(await readFile(playwrightTestPackage, "utf8")) as { version?: unknown }
  if (typeof metadata.version !== "string") throw new Error("Could not read Brandobot's @playwright/test version.")
  return metadata.version
}

function ephemeralTestConfig(outputDirectory: string) {
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

function playwrightTestEnvironment(source = process.env, reportFile?: string) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([key]) => {
      return !isPlaywrightEnvironment(key)
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

type PlaywrightReportSuite = {
  title?: string
  specs?: { title?: string; tests?: { results?: { errors?: unknown[] }[] }[] }[]
  suites?: PlaywrightReportSuite[]
}

type PlaywrightReport = {
  stats?: { expected?: number; flaky?: number; unexpected?: number; skipped?: number }
  errors?: unknown[]
  suites?: PlaywrightReportSuite[]
}

// Playwright colorizes error messages even in its JSON report.
// eslint-disable-next-line no-control-regex -- matching ANSI escapes requires the ESC control character
const ansiPattern = /\x1B\[[0-9;]*[A-Za-z]/g

function stripAnsi(text: string) {
  return text.replace(ansiPattern, "")
}

function reportErrorMessage(error: unknown) {
  const message = typeof error === "string" ? error : (error as { message?: unknown })?.message
  return typeof message === "string" ? stripAnsi(message) : undefined
}

function summarizePlaywrightReport(value: unknown): ReportSummary | undefined {
  const report = value as PlaywrightReport | undefined
  if (!report?.stats) return

  const testNames: string[] = []
  const failures: string[] = (report.errors ?? []).flatMap((error) => {
    const message = reportErrorMessage(error)
    return message !== undefined ? [message] : []
  })
  let retries = 0

  const visitSuite = (suite: PlaywrightReportSuite, titles: string[]) => {
    const nextTitles = suite.title ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      const name = [...nextTitles, spec.title ?? "Unnamed test"].join(" > ")
      testNames.push(name)
      for (const test of spec.tests ?? []) {
        const results = test.results ?? []
        retries += Math.max(0, results.length - 1)
        for (const result of results) {
          for (const error of result.errors ?? []) {
            const message = reportErrorMessage(error)
            if (message !== undefined) failures.push(`${name}: ${message}`)
          }
        }
      }
    }
    for (const child of suite.suites ?? []) visitSuite(child, nextTitles)
  }

  for (const suite of report.suites ?? []) visitSuite(suite, [])
  return {
    passed: (report.stats.expected ?? 0) + (report.stats.flaky ?? 0),
    failed: report.stats.unexpected ?? 0,
    skipped: report.stats.skipped ?? 0,
    retries,
    testNames,
    failures: [...new Set(failures)],
  }
}

function playwrightTestStatus(result: ProcessResult, summary: ReportSummary | undefined) {
  if (result.cancelled) return "cancelled"
  if (result.timedOut) return "timed out"
  if (result.exitCode !== 0) return "failed"
  if (!summary) return "unverified"
  if (summary.failed > 0) return "failed"
  return summary.passed > 0 ? "passed" : "skipped"
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

async function cleanupEphemeralWorkspaces(root = ephemeralWorkspaceDirectory) {
  try {
    const workspaces = await Promise.all(
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(ephemeralWorkspacePrefix))
        .map(async (entry) => {
          const path = join(root, entry.name)
          const active = await stat(join(path, ephemeralWorkspaceActiveFile))
            .then(({ mtimeMs }) => Date.now() - mtimeMs < testProcessTimeout + processTerminationGrace + ephemeralWorkspaceHeartbeat)
            .catch(() => false)
          return { path, mtimeMs: (await stat(path)).mtimeMs, active }
        }),
    )
    const now = Date.now()
    const removals = workspaces
      .sort((first, second) => second.mtimeMs - first.mtimeMs)
      .filter(({ active, mtimeMs }, index) => !active && (index >= ephemeralWorkspaceLimit || now - mtimeMs > ephemeralWorkspaceRetention))
    await Promise.all(removals.map(({ path }) => rm(path, { recursive: true, force: true })))
  } catch {
    // Cleanup is best effort; failed workspaces are retried by a later run.
  }
}

async function createEphemeralTest(source: string) {
  await mkdir(ephemeralWorkspaceDirectory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(ephemeralWorkspaceDirectory, 0o700)
  await cleanupEphemeralWorkspaces()
  const directory = await mkdtemp(join(ephemeralWorkspaceDirectory, ephemeralWorkspacePrefix))
  const packageDirectory = join(directory, "node_modules", "@playwright")
  try {
    await writeFile(join(directory, ephemeralWorkspaceActiveFile), "")
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
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function executeEphemeralTest(source: string, context: ToolContext) {
  try {
    await ensureChromium(context)
  } catch (error) {
    if (!(error instanceof Error && error.message === cancellationMessage)) throw error
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
  context.metadata({ title: "Running Brandobot UI test" })
  const workspace = await createEphemeralTest(source)
  const heartbeat = setInterval(
    () => void writeFile(join(workspace.directory, ephemeralWorkspaceActiveFile), "").catch(() => {}),
    ephemeralWorkspaceHeartbeat,
  )
  try {
    return await executeEphemeralTestWorkspace(workspace, context)
  } finally {
    clearInterval(heartbeat)
    await rm(join(workspace.directory, ephemeralWorkspaceActiveFile), { force: true }).catch(() => undefined)
  }
}

async function executeEphemeralTestWorkspace(
  workspace: Awaited<ReturnType<typeof createEphemeralTest>>,
  context: ToolContext,
) {
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
  const status = playwrightTestStatus(result, summary)
  const passed = status === "passed"
  const counts = summary
    ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.retries} retries`
    : "Test result details were unavailable."
  const lines = [
    `${passed ? "PASS" : status === "skipped" ? "SKIPPED" : status === "unverified" ? "UNVERIFIED" : status === "cancelled" ? "CANCELLED" : "FAIL"} - Brandobot ephemeral validation`,
    `Runner: Brandobot @playwright/test ${version}`,
    `Result: ${counts}`,
    `Duration: ${Date.now() - startedAt}ms`,
    "This test was not saved to the project or validated for CI.",
  ]
  if (summary?.testNames.length) lines.push(`Tests: ${summary.testNames.join(", ")}`)
  if (summary?.failures.length) lines.push(`Failures:\n${summary.failures.slice(0, 5).map((failure) => `- ${failure}`).join("\n")}`)
  if (status === "cancelled") lines.push("The operation was cancelled.")
  if (status === "timed out") lines.push(`The test process exceeded its ${testProcessTimeout}ms limit.`)
  if (status === "unverified") lines.push("The runner exited without a usable JSON report.")
  if (!summary && reportError) lines.push(reportError)
  if (!summary && result.output) lines.push(`Diagnostics:\n${stripAnsi(result.output)}`)
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
        const args = playwrightArgs(input.args, context.sessionID, input.session)
        validatePlaywrightFlags(input.args)
        if (chromiumRequested(input.args)) await ensureChromium(context)
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

export default Object.assign({ id: "@bwanamaker/brandobot", server: Brandobot } satisfies PluginModule, {
  brandobotPlaywrightTestVersion,
  cleanupEphemeralWorkspaces,
  chromiumInstallationComplete,
  chromiumRequested,
  createEphemeralTest,
  defaultBrowserCommand,
  ephemeralTestConfig,
  executeEphemeralTestWorkspace,
  executeProcess,
  playwrightArgs,
  playwrightCommand,
  playwrightEnvironment,
  playwrightOutputDirectory,
  playwrightTestEnvironment,
  playwrightTestStatus,
  summarizePlaywrightReport,
  waitForAbort,
})
