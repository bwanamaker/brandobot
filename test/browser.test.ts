import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import Brandobot, {
  defaultBrowserCommand,
  playwrightArgs,
  playwrightCommand,
  playwrightEnvironment,
  playwrightOutputDirectory,
} from "../src/index.ts"

const {
  brandobotPlaywrightTestVersion,
  cleanupEphemeralWorkspaces,
  chromiumInstallationComplete,
  chromiumRequested,
  ephemeralTestConfig,
  executeProcess,
  playwrightTestEnvironment,
  playwrightTestStatus,
  summarizePlaywrightReport,
  waitForAbort,
} = Brandobot

test("browser validates argv and runs Playwright CLI", async () => {
  const hooks = await Brandobot.server({} as never)
  const browser = hooks.tool?.browser

  expect(browser).toBeDefined()
  expect(tool.schema.object(browser!.args).safeParse({ args: [] }).success).toBe(false)

  const result = await browser!.execute(
    { args: ["--help"] },
    {
      abort: new AbortController().signal,
      agent: "build",
      directory: process.cwd(),
      messageID: "message",
      metadata() {},
      sessionID: "session",
      worktree: process.cwd(),
      async ask() {},
    } satisfies ToolContext,
  )

  expect(result).toContain("playwright-cli")
})

test("browser validates before installing Chromium", async () => {
  const hooks = await Brandobot.server({} as never)
  const browser = hooks.tool?.browser

  await expect(
    browser!.execute(
      { args: ["open", "https://example.com", "--browser=chromium", "--toString"] },
      {
        abort: new AbortController().signal,
        agent: "build",
        directory: process.cwd(),
        messageID: "message",
        metadata() {},
        sessionID: "session",
        worktree: process.cwd(),
        async ask() {},
      } satisfies ToolContext,
    ),
  ).rejects.toThrow("not a supported Playwright CLI option")
})

test("browser sessions default to the OpenCode conversation", () => {
  const automaticSession = playwrightArgs(["open", "https://example.com"], "session-id")
  expect(automaticSession[0]).toMatch(/^-s=brandobot-[a-f0-9]{54}$/)
  expect(automaticSession.slice(1)).toEqual(["open", "https://example.com"])
  const labeledSession = playwrightArgs(["open", "https://example.com"], "session-id", "admin")
  expect(labeledSession[0]).toMatch(/^-s=brandobot-[a-f0-9]{54}$/)
  expect(labeledSession[0]).not.toBe(automaticSession[0])
  expect(labeledSession.slice(1)).toEqual(["open", "https://example.com"])
  expect(playwrightArgs(["install-browser"], "session-id")).toEqual(["install-browser"])
  expect(playwrightArgs(["config-print"], "session-id")[1]).toBe("config-print")
  expect(playwrightArgs(["open", "https://example.com"], "session/../id")[0]).not.toBe(
    playwrightArgs(["open", "https://example.com"], "session?../id")[0],
  )
  expect(playwrightArgs(["--help"], "session-id")).toEqual(["--help"])
  expect(() => playwrightArgs(["close-all"], "session-id")).toThrow("not available")
  expect(() => playwrightArgs(["-s", "admin", "close-all"], "session-id")).toThrow("session argument")
  expect(() => playwrightArgs(["-s/../../other", "close-all"], "session-id")).toThrow("session argument")
  expect(() => playwrightArgs(["--session", "admin", "close-all"], "session-id")).toThrow("session argument")
  expect(() => playwrightArgs(["--session/../../other", "close-all"], "session-id")).toThrow("session argument")
  expect(() => playwrightArgs(["attach", "--cdp=chrome"], "session-id")).toThrow("not available")
  expect(() => playwrightArgs(["--cdp", "chrome", "attach"], "session-id")).toThrow("external browser state")
  expect(() => playwrightArgs(["--port", "0", "show"], "session-id")).toThrow("first args token")
  expect(() => playwrightArgs(["open", "https://example.com", "--profile=/tmp/profile"], "session-id")).toThrow(
    "external browser state",
  )
  expect(() => playwrightArgs(["open", "https://example.com"], "session-id", "../other")).toThrow("session names")
  expect(() => playwrightArgs(["screenshot"], "session-id")).toThrow("Ask the user where to store the screenshot")
  expect(() => playwrightArgs(["screenshot", "--filename", "image.png"], "session-id")).toThrow(
    "Ask the user where to store the screenshot",
  )
  const screenshot = playwrightArgs(["screenshot", "--filename", "artifacts/image.png"], "session-id")
  expect(screenshot[1]).toBe("screenshot")
  expect(screenshot[3]).toMatch(/^artifacts\/image-\d{8}-\d{9}\.png$/)
  expect(playwrightArgs(["screenshot", "--filename=artifacts/image.png"], "session-id")[2]).toMatch(
    /^--filename=artifacts\/image-\d{8}-\d{9}\.png$/,
  )
  const windowsScreenshot = playwrightArgs(["screenshot", "--filename", "artifacts\\image.png"], "session-id")
  expect(windowsScreenshot[3]).toMatch(/^artifacts\\image-\d{8}-\d{9}\.png$/)
  expect(() => playwrightArgs(["video-start", "recording.webm"], "session-id")).toThrow(
    "Ask the user where to store the video",
  )
  const video = playwrightArgs(["video-start", "artifacts/recording.webm"], "session-id")
  expect(video[1]).toBe("video-start")
  expect(video[2]).toMatch(/^artifacts\/recording-\d{8}-\d{9}\.webm$/)
  expect(playwrightArgs(["video-start", "artifacts/recording-20260905-203834123.webm"], "session-id")[2]).toBe(
    "artifacts/recording-20260905-203834123.webm",
  )
})

test("default browser commands are platform-safe", () => {
  expect(defaultBrowserCommand("https://example.com", "darwin", {})).toEqual(["open", "https://example.com/"])
  expect(defaultBrowserCommand("https://example.com", "win32", {})).toEqual(["explorer.exe", "https://example.com/"])
  expect(defaultBrowserCommand("https://example.com", "linux", { DISPLAY: ":0" })).toEqual([
    "xdg-open",
    "https://example.com/",
  ])
  expect(() => defaultBrowserCommand("file:///tmp/example", "darwin", {})).toThrow("Only http: and https: URLs")
  expect(() => defaultBrowserCommand("https://example.com", "linux", {})).toThrow("headless Linux")
})

test("Playwright environment suppresses inherited connection and debug configuration", () => {
  const environment = playwrightEnvironment({
    PATH: "/bin",
    PLAYWRIGHT_MCP_CDP_ENDPOINT: "ws://example.com",
    PWDEBUG: "1",
    PWTEST_DAEMON_SESSION_DIR: "/external-sessions",
    npm_config_pwdebug: "1",
  })

  expect(environment.PATH).toBe("/bin")
  expect(environment.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined()
  expect(environment.PWDEBUG).toBeUndefined()
  expect(environment.PWTEST_DAEMON_SESSION_DIR).toBeUndefined()
  expect(environment.npm_config_pwdebug).toBeUndefined()
  expect(environment.PLAYWRIGHT_MCP_ISOLATED).toBe("true")
  expect(environment.PLAYWRIGHT_BROWSERS_PATH).toContain("brandobot")
  expect(environment.PWTEST_CLI_GLOBAL_CONFIG).toContain("brandobot-playwright-")
})

test("Playwright open and artifacts use isolated configuration", () => {
  const first = playwrightArgs(["open", "https://example.com"], "first-session")
  const second = playwrightArgs(["open", "https://example.com"], "second-session")
  const command = playwrightCommand(first)
  const firstOutput = playwrightOutputDirectory(first)
  const secondOutput = playwrightOutputDirectory(second)

  expect(command.slice(1, 4)).toEqual(["--config", expect.stringContaining("brandobot-playwright-"), "-s=" + first[0].slice(3)])
  expect(command).toContain("open")
  expect(firstOutput.startsWith(tmpdir())).toBe(true)
  expect(firstOutput).toContain("brandobot-playwright-")
  expect(firstOutput).toContain(first[0].slice(3))
  expect(secondOutput).toContain(second[0].slice(3))
  expect(firstOutput).not.toBe(secondOutput)
})

test("process cancellation terminates child processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brandobot-cancellation-"))
  const marker = join(directory, "child.pid")
  const controller = new AbortController()
  let childPID: number | undefined
  let execution: ReturnType<typeof executeProcess> | undefined
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"
  const child = `import { writeFileSync } from "node:fs"; const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(grandchild)}], { detached: true, stdout: "ignore", stderr: "ignore" }); writeFileSync(process.env.BRANDOBOT_MARKER, String(child.pid))`
  const script = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(child)}], { detached: true, stdout: "ignore", stderr: "ignore" }); setInterval(() => {}, 60000)`

  try {
    execution = executeProcess(
      [process.execPath, "-e", script],
      {
        abort: controller.signal,
        agent: "build",
        directory,
        messageID: "message",
        metadata() {},
        sessionID: "session",
        worktree: directory,
        async ask() {},
      } satisfies ToolContext,
      { ...process.env, BRANDOBOT_MARKER: marker },
    )
    for (let attempt = 0; attempt < 50 && !childPID; attempt++) {
      try {
        childPID = Number(await readFile(marker, "utf8"))
      } catch {
        await Bun.sleep(20)
      }
    }
    expect(childPID).toBeDefined()

    controller.abort()
    expect(await execution).toMatchObject({ cancelled: true })
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(childPID!, 0)
      } catch {
        break
      }
      await Bun.sleep(20)
    }
    expect(() => process.kill(childPID!, 0)).toThrow()
  } finally {
    controller.abort()
    await execution?.catch(() => undefined)
    if (childPID) {
      try {
        process.kill(childPID, "SIGKILL")
      } catch {
        // The assertion above already confirmed the child exited.
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test("ephemeral workspace cleanup retains recent workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "brandobot-cleanup-"))
  const now = Date.now()

  try {
    await Promise.all(
      Array.from({ length: 21 }, async (_, index) => {
        const directory = join(root, `run-${index}`)
        await mkdir(directory)
        await utimes(directory, now / 1_000 - index, now / 1_000 - index)
      }),
    )
    const expired = join(root, "run-expired")
    await mkdir(expired)
    await utimes(expired, now / 1_000 - 2 * 24 * 60 * 60, now / 1_000 - 2 * 24 * 60 * 60)
    const active = join(root, "run-active")
    await mkdir(active)
    await writeFile(join(active, ".brandobot-active"), "")
    await utimes(active, now / 1_000 - 2 * 24 * 60 * 60, now / 1_000 - 2 * 24 * 60 * 60)
    await mkdir(join(root, "unrelated"))

    await cleanupEphemeralWorkspaces(root)

    const entries = await readdir(root)
    expect(entries).toContain("run-0")
    expect(entries).not.toContain("run-20")
    expect(entries).not.toContain("run-expired")
    expect(entries).toContain("run-active")
    expect(entries).toContain("unrelated")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Chromium installation requires Playwright's completion marker", async () => {
  const cache = await mkdtemp(join(tmpdir(), "brandobot-chromium-"))
  const browserDirectory = join(cache, "chromium-1")
  const executable = join(browserDirectory, "chrome")

  try {
    await mkdir(browserDirectory)
    await writeFile(executable, "")
    expect(await chromiumInstallationComplete(executable, cache)).toBe(false)
    await writeFile(join(browserDirectory, "INSTALLATION_COMPLETE"), "")
    expect(await chromiumInstallationComplete(executable, cache)).toBe(true)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

test("ephemeral UI tests use bundled Chromium and summarize results", async () => {
  const hooks = await Brandobot.server({} as never)
  const runner = hooks.tool?.run_ui_test

  expect(runner).toBeDefined()
  expect(tool.schema.object(runner!.args).safeParse({ source: "" }).success).toBe(false)
  expect(chromiumRequested(["open", "https://example.com", "--browser=chromium"])).toBe(true)
  expect(chromiumRequested(["open", "https://example.com", "--browser", "chromium"])).toBe(true)
  expect(chromiumRequested(null as never)).toBe(false)
  expect(chromiumRequested(["open", "--help", "--browser=chromium"])).toBe(false)
  expect(chromiumRequested(["open", "--", "--browser=chromium"])).toBe(false)
  expect(chromiumRequested(["open", "https://example.com"])).toBe(false)
  expect(ephemeralTestConfig("/tmp/artifacts")).toContain('outputDir: "/tmp/artifacts"')
  expect(ephemeralTestConfig("/tmp/artifacts")).toContain('trace: "retain-on-failure"')
  expect(
    playwrightTestEnvironment({
      PATH: "/bin",
      PLAYWRIGHT_JSON_OUTPUT_FILE: "/project/report.json",
      PWDEBUG: "1",
      PwDebug: "1",
      npm_config_pwdebug: "1",
      npm_package_config_pwdebug: "1",
      PW_TEST_REPORTER: "dot",
      PWTEST_CACHE_DIR: "/project/cache",
      PLAYWRIGHT_BROWSERS_PATH: "/browser-cache",
    }, "/tmp/report.json"),
  ).toEqual({
    PATH: "/bin",
    PLAYWRIGHT_BROWSERS_PATH: expect.stringContaining("brandobot"),
    PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/report.json",
  })
  expect(playwrightTestStatus({ exitCode: 0, output: "", timedOut: false, cancelled: false }, undefined)).toBe("unverified")
  expect(await brandobotPlaywrightTestVersion()).toMatch(/^\d+\./)
  expect(
    summarizePlaywrightReport({
      stats: { expected: 1, flaky: 1, unexpected: 1, skipped: 1 },
      suites: [
        {
          title: "checkout.spec.ts",
          specs: [
            {
              title: "guest checkout",
              tests: [
                {
                  results: [
                    { errors: [{ message: "first failure" }] },
                    { errors: [{ message: "second \x1B[31mfailure\x1B[39m" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  ).toEqual({
    passed: 2,
    failed: 1,
    skipped: 1,
    retries: 1,
    testNames: ["checkout.spec.ts > guest checkout"],
    failures: [
      "checkout.spec.ts > guest checkout: first failure",
      "checkout.spec.ts > guest checkout: second failure",
    ],
  })
})

test("waitForAbort detaches its listener when the value settles", async () => {
  const detached: string[] = []
  const trackDetach = (signal: AbortSignal) => {
    const remove = signal.removeEventListener.bind(signal)
    signal.removeEventListener = (type, listener, options) => {
      detached.push(type)
      return remove(type, listener, options)
    }
    return signal
  }

  await expect(waitForAbort(Promise.resolve("installed"), trackDetach(new AbortController().signal))).resolves.toBe("installed")
  await expect(waitForAbort(Promise.reject(new Error("failed")), trackDetach(new AbortController().signal))).rejects.toThrow("failed")
  expect(detached).toEqual(["abort", "abort"])
  await expect(waitForAbort(Promise.resolve("late"), AbortSignal.abort())).rejects.toThrow("cancelled")
})

test("ephemeral UI tests report an already-cancelled request", async () => {
  const hooks = await Brandobot.server({} as never)
  const runner = hooks.tool?.run_ui_test
  const controller = new AbortController()
  controller.abort()

  const result = await runner!.execute(
    { source: 'import { test } from "@playwright/test"; test("never runs", () => {})' },
    {
      abort: controller.signal,
      agent: "build",
      directory: process.cwd(),
      messageID: "cancelled",
      metadata() {},
      sessionID: "session",
      worktree: process.cwd(),
      async ask() {},
    } satisfies ToolContext,
  )

  expect(result).toMatchObject({ metadata: { status: "cancelled", runner: "brandobot" } })
})

test("plugin adds browser routing guidance", async () => {
  const hooks = await Brandobot.server({} as never)
  const output = { system: [] as string[] }

  await hooks["experimental.chat.system.transform"]!({} as never, output)

  expect(output.system.join("\n")).toContain("Use open_url")
  expect(output.system.join("\n")).toContain("--browser=chromium")
  expect(output.system.join("\n")).toContain("MUST call the question tool before any browser command or text response")
  expect(output.system.join("\n")).toContain('label "artifacts/"')
  expect(output.system.join("\n")).toContain('label "artifacts/ (Always)"')
  expect(output.system.join("\n")).toContain("do not ask again")
  expect(output.system.join("\n")).toContain("Do not ask this question in plain text")
  expect(output.system.join("\n")).toContain("Use run_ui_test")
  expect(output.system.join("\n")).toContain("not CI validation")
})
