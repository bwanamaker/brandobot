import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { Check } from "typebox/value"
import { createEphemeralTest, executeEphemeralTestWorkspace, executeProcess, playwrightArgs } from "../dist/core.js"

let directory
let extension
let context
const tool = (name) => extension.tools.get(name).definition
const execute = (name, input, signal) => tool(name).execute("test-call", input, signal, undefined, context)

before(async () => {
  assert.equal(typeof globalThis.Bun, "undefined", "Pi compatibility must be tested under Node.js")
  directory = await mkdtemp(join(tmpdir(), "brandobot-pi-"))
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [fileURLToPath(new URL("..", import.meta.url))] }),
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  })
  await loader.reload()
  const loaded = loader.getExtensions()
  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.extensions.length, 1)
  extension = loaded.extensions[0]
  context = { cwd: directory, sessionManager: SessionManager.inMemory(directory), hasUI: false }
})

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("Pi discovers the package, validates tool inputs, and gets host-specific guidance", async () => {
  assert.deepEqual([...extension.tools.keys()].sort(), ["browser", "open_url", "run_ui_test"])
  assert.equal(Check(tool("browser").parameters, { args: [] }), false)
  assert.equal(Check(tool("browser").parameters, { args: ["snapshot"], session: "../other" }), false)
  assert.equal(Check(tool("browser").parameters, { args: ["snapshot"], session: "admin" }), true)
  assert.equal(Check(tool("run_ui_test").parameters, { source: "" }), false)
  assert.equal(Check(tool("run_ui_test").parameters, { source: "x".repeat(100_001) }), false)
  await assert.rejects(execute("open_url", { url: "file:///tmp/example" }), /Only http: and https:/)
  await assert.rejects(execute("browser", { args: ["open", "https://example.com", "--browser=chromium", "--config=external.json"] }), /external browser state/)

  const event = { systemPromptOptions: { sections: { existing: "Keep this" } } }
  for (const handler of extension.handlers.get("before_agent_start")) await handler(event, context)
  assert.equal(event.systemPromptOptions.sections.existing, "Keep this")
  const guidance = event.systemPromptOptions.sections.brandobot
  assert.match(guidance, /Pi host/)
  assert.match(guidance, /Use run_ui_test/)
  assert.match(guidance, /ask the user where to save it and wait/)
  assert.doesNotMatch(guidance, /question tool|webfetch|OpenCode/)
})

test("Pi runs the CLI on Node and scopes browser labels to the current session", async () => {
  const help = await execute("browser", { args: ["--help"] })
  assert.equal(help.content[0].type, "text")
  assert.match(help.content[0].text, /playwright-cli/)

  const session = "admin"
  const first = context.sessionManager.getSessionId()
  for (let index = 0; index < 2; index++) {
    const sessionID = `pi:${context.sessionManager.getSessionId()}`
    const expected = playwrightArgs(["snapshot"], sessionID, session)[0].slice(3)
    await assert.rejects(execute("browser", { args: ["snapshot"], session }), (error) => {
      assert.ok(error.message.includes(expected), error.message)
      return true
    })
    context.sessionManager.newSession()
    assert.notEqual(context.sessionManager.getSessionId(), first)
  }
})

test("Pi forwards cancellation and preserves structured UI test results", async () => {
  await assert.rejects(execute("browser", { args: ["--help"] }, AbortSignal.abort()), /cancelled/)
  const cancelled = await execute("run_ui_test", { source: 'import { test } from "@playwright/test"; test("never runs", () => {})' }, AbortSignal.abort())
  assert.equal(cancelled.details.status, "cancelled")
  assert.equal(cancelled.details.runner, "brandobot")
  assert.match(cancelled.content[0].text, /CANCELLED/)

  const coreContext = { directory, sessionID: "node-test", abort: new AbortController().signal, metadata() {} }
  for (const [status, body] of [["passed", ""], ["failed", 'throw new Error("expected failure")']]) {
    const workspace = await createEphemeralTest(`import { test } from "@playwright/test"; test("${status}", () => { ${body} })`)
    try {
      const result = await executeEphemeralTestWorkspace(workspace, coreContext)
      assert.equal(result.metadata.status, status)
      assert.match(result.output, /Brandobot ephemeral validation/)
    } finally {
      await rm(workspace.directory, { recursive: true, force: true })
    }
  }

  const result = await executeProcess([process.execPath, "-e", "setInterval(() => {}, 60000)"], coreContext, process.env, 100)
  assert.equal(result.timedOut, true)
  await assert.rejects(executeProcess([join(directory, "missing-executable")], coreContext), /ENOENT/)
})
