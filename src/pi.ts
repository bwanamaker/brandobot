import type { ExtensionAPI, ExtensionContext, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { browserGuidance, executeBrowser, executeEphemeralTest, openUrl, sessionName, toolDescriptions, uiTestingGuidance, type ToolContext } from "./core.js"

function toolContext(ctx: ExtensionContext, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback | undefined): ToolContext {
  return {
    directory: ctx.cwd,
    sessionID: `pi:${ctx.sessionManager.getSessionId()}`,
    abort: signal ?? new AbortController().signal,
    metadata({ title, metadata }) {
      if (title) onUpdate?.({ content: [{ type: "text", text: title }], details: metadata })
    },
  }
}

export default function brandobot(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.brandobot = `${browserGuidance("Pi")}\n\n${uiTestingGuidance}`
  })

  pi.registerTool({
    name: "open_url",
    label: "Open URL",
    description: toolDescriptions.open_url,
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to open in the user's default browser." }),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      const text = await openUrl(input.url, toolContext(ctx, signal, onUpdate))
      return { content: [{ type: "text", text }], details: undefined }
    },
  })

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: toolDescriptions.browser,
    executionMode: "sequential",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { minItems: 1, description: "Playwright CLI argv tokens, without the executable name." }),
      session: Type.Optional(Type.String({ pattern: sessionName.source, description: "Optional browser label scoped to the current Pi conversation." })),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      const text = await executeBrowser(input, toolContext(ctx, signal, onUpdate))
      return { content: [{ type: "text", text }], details: undefined }
    },
  })

  pi.registerTool({
    name: "run_ui_test",
    label: "Run UI test",
    description: toolDescriptions.run_ui_test,
    parameters: Type.Object({
      source: Type.String({ minLength: 1, maxLength: 100_000, description: "Complete TypeScript Playwright spec importing from @playwright/test." }),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      const result = await executeEphemeralTest(input.source, toolContext(ctx, signal, onUpdate))
      return { content: [{ type: "text", text: result.output }], details: result.metadata }
    },
  })
}
