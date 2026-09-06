import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import Brandobot, {
  defaultBrowserCommand,
  playwrightArgs,
  playwrightCommand,
  playwrightEnvironment,
  playwrightOutputDirectory,
} from "../src/index.ts"

test("browser validates argv and runs Playwright CLI", async () => {
  const hooks = await Brandobot({} as never)
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

test("Playwright environment suppresses inherited connection configuration", () => {
  const environment = playwrightEnvironment({ PATH: "/bin", PLAYWRIGHT_MCP_CDP_ENDPOINT: "ws://example.com" })

  expect(environment.PATH).toBe("/bin")
  expect(environment.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBeUndefined()
  expect(environment.PLAYWRIGHT_MCP_ISOLATED).toBe("true")
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

test("plugin adds browser routing guidance", async () => {
  const hooks = await Brandobot({} as never)
  const output = { system: [] as string[] }

  await hooks["experimental.chat.system.transform"]!({} as never, output)

  expect(output.system.join("\n")).toContain("Use open_url")
  expect(output.system.join("\n")).toContain("--browser=chromium")
  expect(output.system.join("\n")).toContain("MUST call the question tool before any browser command or text response")
  expect(output.system.join("\n")).toContain('label "artifacts/"')
  expect(output.system.join("\n")).toContain('label "artifacts/ (Always)"')
  expect(output.system.join("\n")).toContain("do not ask again")
  expect(output.system.join("\n")).toContain("Do not ask this question in plain text")
})
