import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"

const require = createRequire(import.meta.url)
const playwrightCli = join(dirname(require.resolve("@playwright/cli/package.json")), "playwright-cli.js")

async function execute(args: string[], context: ToolContext) {
  const process = Bun.spawn({
    cmd: [playwrightCli, ...args],
    cwd: context.directory,
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
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")

  if (exitCode !== 0) {
    throw new Error(`playwright-cli exited with status ${exitCode}${output ? `:\n${output}` : ""}`)
  }

  return output
}

const Brandobot: Plugin = async () => ({
  tool: {
    browser: tool({
      description:
        "Run a Playwright CLI command. Pass each token after playwright-cli in args, without a shell or the executable name. Use open before page actions; command responses include snapshots with element refs for later actions. Set session to use a persistent named browser session.",
      args: {
        args: tool.schema
          .array(tool.schema.string())
          .min(1)
          .describe('Playwright CLI argv tokens, for example ["open", "https://example.com"] or ["click", "e12"].'),
        session: tool.schema.string().min(1).optional().describe("Optional Playwright CLI named session."),
      },
      async execute(input, context) {
        const args = input.session ? [`-s=${input.session}`, ...input.args] : input.args
        return execute(args, context)
      },
    }),
  },
})

export default Brandobot
