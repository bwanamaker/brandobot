import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"
import * as core from "./core.js"

export { defaultBrowserCommand, playwrightArgs, playwrightCommand, playwrightEnvironment, playwrightOutputDirectory } from "./core.js"

const Brandobot: Plugin = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(core.browserGuidance("OpenCode"))
    output.system.push(core.uiTestingGuidance)
  },
  tool: {
    open_url: tool({
      description: core.toolDescriptions.open_url,
      args: {
        url: tool.schema.string().url().describe("The http(s) URL to open in the user's default browser."),
      },
      async execute(input, context) {
        return core.openUrl(input.url, context)
      },
    }),
    browser: tool({
      description: core.toolDescriptions.browser,
      args: {
        args: tool.schema
          .array(tool.schema.string())
          .min(1)
          .describe('Playwright CLI argv tokens, for example ["open", "https://example.com"] or ["click", "e12"].'),
        session: tool.schema
          .string()
          .regex(core.sessionName, "Use letters, numbers, hyphens, and underscores only.")
          .optional()
          .describe("Optional browser label scoped to the current OpenCode conversation."),
      },
      execute: core.executeBrowser,
    }),
    run_ui_test: tool({
      description: core.toolDescriptions.run_ui_test,
      args: {
        source: tool.schema
          .string()
          .min(1)
          .max(100_000)
          .describe('Complete TypeScript Playwright spec source, for example: import { expect, test } from "@playwright/test"; test("home", async ({ page }) => { await page.goto("https://example.com"); await expect(page).toHaveTitle(/Example/); });'),
      },
      async execute(input, context) {
        return core.executeEphemeralTest(input.source, context)
      },
    }),
  },
})

export default Object.assign({ id: "@bwanamaker/brandobot", server: Brandobot } satisfies PluginModule, core)
