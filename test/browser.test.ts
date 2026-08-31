import { expect, test } from "bun:test"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import Brandobot from "../src/index.ts"

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
