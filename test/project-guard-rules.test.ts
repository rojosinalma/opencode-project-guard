import { expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import plugin, {
  appendText,
  decideRules,
  parseRegex,
  resolveOptions,
  ruleText,
  subjectsOf,
  turnHasCompletedTool,
  type Rule,
} from "../index.ts"

const home = os.homedir()
const h = (p: string) => path.join(home, p)
const FOO = h("dev/foo")
const quiet = () => {}
const rules = (...list: any[]) => resolveOptions({ rules: list }, quiet)
const hitIds = (opts: ReturnType<typeof resolveOptions>, tool: string, input: unknown, dir = FOO) => decideRules(opts, dir, tool, input).map((x) => x.rule.id)

// --- the six house rules, verbatim ---------------------------------------------------------------

const HOUSE = [
  {
    id: "opencode-upgrade",
    tools: ["shell", "bash"],
    match: [
      "/\\bopencode\\s+upgrade\\b/i",
      "/\\b(npm|pnpm|yarn|bun)\\s+(i|install|add)(\\s+-[-\\w]+)*\\s+(-g|--global)\\b.*\\bopencode\\b/i",
      "/\\b(npm|pnpm|yarn|bun)\\s+(i|install|add)(\\s+-[-\\w]+)*\\s+(-g|--global)\\b.*@opencode\\/cli/i",
      "/opencode\\.ai\\/install/i",
    ],
    message: "The opencode binary is managed by the openchamber-updater runner (`opencode upgrade` would install 1.18.x and break openchamber). Never upgrade it by hand; report to the user instead.",
  },
  {
    id: "cf-zerotrust",
    tools: ["shell", "bash"],
    match: ["/cf-zerotrust[^\\n;&|]*\\bsync\\.rb\\b/", "/cd\\s+[^\\n;&|]*cf-zerotrust\\b[^\\n]*\\bsync\\.rb\\b/"],
    message: "~/dev/cf-zerotrust is decommissioned; its sync.rb must never run (Cloudflare routing is owned by the deployer).",
  },
  {
    id: "dot-local",
    tools: ["shell", "bash", "edit", "write", "patch"],
    match: ["/(?<![\\w.-])[a-z0-9-]+\\.local\\b(?![\\w.-])/i"],
    except: ["/^rc\\.local$/"],
    message: "`.local` hostnames are gone (mDNS). Use `<sub>.rojo.internal` (canonical) or `<sub>.<host>.internal` instead.",
  },
  {
    id: "commit-attribution",
    tools: ["shell", "bash"],
    match: ["/\\bgit\\b[^\\n]*\\bcommit\\b[\\s\\S]*?(co-authored-by|generated (with|by)|🤖)/i"],
    message: "No AI/agent attribution in commits: drop the Co-Authored-By / 'Generated with' line and commit with the host identity as-is.",
  },
  {
    id: "print-approval",
    tools: ["execute"],
    match: ["/\\b(print_library_file|add_files_to_queue|add_to_queue|start_queue_item|create_batch|dispatch_batch|reprint_archive|webhook_start_print)\\b/"],
    unless_turn_tool: "question",
    message: "Starting or queueing a 3D print needs the user's question-tool approval of that exact job (file, plate, printer, copies) in this turn. Ask first.",
  },
  {
    id: "compose-deployer",
    kind: "warn",
    tools: ["edit", "write", "patch"],
    on: ["path"],
    match: ["/(^|\\/)(docker-)?compose[\\w.-]*\\.ya?ml$/m"],
    allow_from: ["~/dev/deployer"],
    message: "Reminder: if this service is deployer-managed, its compose is rewritten by the deployer — change it through `PUT /api/services/:id/compose` + start (deployer-api skill), not by hand.",
  },
]
const house = resolveOptions({ rules: HOUSE }, quiet)
const sh = (command: string, workdir?: string) => ({ command, ...(workdir ? { workdir } : {}) })

// --- resolveOptions ------------------------------------------------------------------------------

test("no rules by default; a non-array rules option is ignored", () => {
  expect(resolveOptions().rules).toEqual([])
  expect(resolveOptions({ guards: [] }).rules).toEqual([])
  const warnings: string[] = []
  expect(resolveOptions({ rules: "x" }, (m) => warnings.push(m)).rules).toEqual([])
  expect(warnings).toHaveLength(1)
})

test("a rule resolves with defaults: kind refuse, no on/except/allow_from", () => {
  const [r] = rules({ id: "a", tools: ["shell"], match: "foo", message: "m" }).rules
  expect(r.id).toBe("a")
  expect(r.kind).toBe("refuse")
  expect(r.tools).toEqual(["shell"])
  expect(r.match).toHaveLength(1)
  expect(r.match[0].source).toBe("foo")
  expect(r.match[0].flags).toBe("")
  expect(r.except).toBeUndefined()
  expect(r.on).toBeUndefined()
  expect(r.allow_from).toBeUndefined()
  expect(r.unless_turn_tool).toBeUndefined()
})

test("invalid rules are dropped with a warning, never a crash", () => {
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const bad = [
    null,
    "str",
    { tools: ["shell"], match: "a", message: "m" }, // no id
    { id: "no-tools", match: "a", message: "m" },
    { id: "empty-tools", tools: [], match: "a", message: "m" },
    { id: "no-message", tools: ["shell"], match: "a" },
    { id: "no-match", tools: ["shell"], message: "m" },
    { id: "bad-regex", tools: ["shell"], match: "/(/", message: "m" },
    { id: "bad-regex-plain", tools: ["shell"], match: "(", message: "m" },
    { id: "bad-kind", tools: ["shell"], match: "a", message: "m", kind: "block" },
    { id: "bad-on", tools: ["shell"], match: "a", message: "m", on: ["nope"] },
    { id: "bad-except", tools: ["shell"], match: "a", message: "m", except: [1] },
    { id: "bad-allow", tools: ["shell"], match: "a", message: "m", allow_from: "~/dev" },
    { id: "bad-turn", tools: ["shell"], match: "a", message: "m", unless_turn_tool: 3 },
    { id: "ok", tools: ["shell"], match: "a", message: "m" },
  ]
  const opts = resolveOptions({ rules: bad }, warn)
  expect(opts.rules.map((r) => r.id)).toEqual(["ok"])
  expect(warnings).toHaveLength(bad.length - 1)
  expect(warnings.every((w) => w.startsWith("dropping invalid rule"))).toBe(true)
})

test("regex forms: /body/flags and plain patterns; string or array", () => {
  expect(parseRegex("/foo/i")!.flags).toBe("i")
  expect(parseRegex("/foo/i")!.source).toBe("foo")
  expect(parseRegex("a/b")!.source).toBe("a\\/b")
  expect(parseRegex("/a\\/b/")!.source).toBe("a\\/b")
  expect(parseRegex("/(/")).toBeUndefined()
  const [r] = rules({ id: "a", tools: ["shell"], match: ["/x/i", "y"], except: "/z/m", message: "m" }).rules
  expect(r.match.map((m) => `${m.source}|${m.flags}`)).toEqual(["x|i", "y|"])
  expect(r.except!.map((m) => `${m.source}|${m.flags}`)).toEqual(["z|m"])
})

test("allow_from expands ~ and kind/on/unless_turn_tool are kept", () => {
  const [r] = rules({ id: "a", kind: "warn", tools: ["edit"], on: ["path", "content"], match: "x", message: "m", allow_from: ["~/dev/deployer", "/srv"], unless_turn_tool: "question" }).rules
  expect(r.kind).toBe("warn")
  expect(r.on).toEqual(["path", "content"])
  expect(r.allow_from).toEqual([h("dev/deployer"), "/srv"])
  expect(r.unless_turn_tool).toBe("question")
})

// --- subjectsOf --------------------------------------------------------------------------------

test("subjectsOf per tool", () => {
  expect(subjectsOf("shell", { command: "ls" }, FOO)).toEqual({ command: "ls" })
  expect(subjectsOf("bash", { command: "ruby sync.rb", workdir: "~/dev/x" }, FOO)).toEqual({ command: "cd ~/dev/x && ruby sync.rb" })
  expect(subjectsOf("shell", { command: "" }, FOO)).toEqual({})
  expect(subjectsOf("shell", null, FOO)).toEqual({})
  expect(subjectsOf("edit", { path: "a.rb", oldString: "old", newString: "new" }, FOO)).toEqual({ path: h("dev/foo/a.rb"), content: "new" })
  expect(subjectsOf("write", { filePath: "/abs/b.txt", content: "body" }, FOO)).toEqual({ path: "/abs/b.txt", content: "body" })
  const patchText = `*** Begin Patch\n*** Update File: x.yml\n*** Add File: y.yml\n@@\n+a\n*** End Patch`
  expect(subjectsOf("patch", { patchText }, FOO)).toEqual({ path: `${h("dev/foo/x.yml")}\n${h("dev/foo/y.yml")}`, content: patchText })
  expect(subjectsOf("execute", { code: "return 1" }, FOO)).toEqual({ code: "return 1" })
  expect(subjectsOf("execute", {}, FOO)).toEqual({})
  expect(subjectsOf("webfetch", { url: "http://x" }, FOO)).toEqual({ name: "webfetch", input: '{"url":"http://x"}' })
})

// --- decideRules semantics ---------------------------------------------------------------------

test("rules apply only to the tools they list", () => {
  const opts = rules({ id: "a", tools: ["shell"], match: "foo", message: "m" })
  expect(hitIds(opts, "shell", sh("foo"))).toEqual(["a"])
  expect(hitIds(opts, "bash", sh("foo"))).toEqual([])
  expect(hitIds(opts, "edit", { path: "foo", newString: "foo" })).toEqual([])
})

test("except skips matches whose text matches; another match still counts", () => {
  const opts = rules({ id: "a", tools: ["shell"], match: "[a-z]+\\.local", except: ["^rc\\.local$"], message: "m" })
  expect(hitIds(opts, "shell", sh("cat /etc/rc.local"))).toEqual([])
  expect(hitIds(opts, "shell", sh("cat /etc/rc.local; ping pi.local"))).toEqual(["a"])
  expect(decideRules(opts, FOO, "shell", sh("cat /etc/rc.local; ping pi.local"))[0].match).toBe("pi.local")
})

test("configured regexes are not mutated by iteration", () => {
  const opts = rules({ id: "a", tools: ["shell"], match: "/x/g", message: "m" })
  expect(hitIds(opts, "shell", sh("x"))).toEqual(["a"])
  expect(hitIds(opts, "shell", sh("x"))).toEqual(["a"])
  expect(opts.rules[0].match[0].lastIndex).toBe(0)
})

test("allow_from skips the rule for sessions under those roots", () => {
  const opts = rules({ id: "a", tools: ["shell"], match: "x", message: "m", allow_from: ["~/dev/deployer"] })
  expect(hitIds(opts, "shell", sh("x"), FOO)).toEqual(["a"])
  expect(hitIds(opts, "shell", sh("x"), h("dev/deployer"))).toEqual([])
  expect(hitIds(opts, "shell", sh("x"), h("dev/deployer/lib"))).toEqual([])
  expect(hitIds(opts, "shell", sh("x"), h("dev/deployer-ui"))).toEqual(["a"])
})

test("on restricts the inspected fields", () => {
  const pathOnly = rules({ id: "p", tools: ["write"], on: ["path"], match: "secret", message: "m" })
  const all = rules({ id: "p", tools: ["write"], match: "secret", message: "m" })
  expect(hitIds(pathOnly, "write", { path: "a.txt", content: "secret" })).toEqual([])
  expect(hitIds(pathOnly, "write", { path: "secret.txt", content: "" })).toEqual(["p"])
  expect(hitIds(all, "write", { path: "a.txt", content: "secret" })).toEqual(["p"])
  expect(decideRules(all, FOO, "write", { path: "a.txt", content: "secret" })[0].field).toBe("content")
})

test("ruleText carries kind, tool, match, field and substitutes placeholders", () => {
  const opts = rules({ id: "a", tools: ["shell"], match: "foo", message: "{id}/{tool}/{match}/{directory}/{subject}" }, { id: "w", kind: "warn", tools: ["shell"], match: "foo", message: "m" })
  const [a, w] = decideRules(opts, FOO, "shell", sh("foo"))
  expect(ruleText(a, FOO)).toBe(`[project-guard] rule \`a\` refused \`shell\`: matched "foo" in command. a/shell/foo/${FOO}/command`)
  expect(ruleText(w, FOO)).toBe('[project-guard] rule `w` warning for `shell`: matched "foo" in command. m')
})

// --- turnHasCompletedTool ----------------------------------------------------------------------

const msg = (id: string, type: string, parts: any[] = []) => ({ id, type, content: parts })
const toolPart = (name: string, status: string) => ({ type: "tool", name, state: { status } })

test("turnHasCompletedTool", () => {
  const prevTurn = [msg("u1", "user"), msg("a1", "assistant", [toolPart("question", "completed")])]
  const thisTurn = [msg("u2", "user"), msg("a2", "assistant", [{ type: "text", text: "hi" }]), msg("a3", "assistant", [toolPart("execute", "running")])]
  const all = [...prevTurn, ...thisTurn]
  expect(turnHasCompletedTool(all, "a3", "question")).toBe(false) // previous turn's question does not count
  expect(turnHasCompletedTool([...all.slice(0, 3), msg("a2b", "assistant", [toolPart("question", "completed")]), all[4]], "a3", "question")).toBe(true)
  expect(turnHasCompletedTool([...all.slice(0, 4), msg("a3", "assistant", [toolPart("question", "completed")])], "a3", "question")).toBe(true) // same message
  expect(turnHasCompletedTool([...all.slice(0, 4), msg("a3", "assistant", [toolPart("question", "pending")])], "a3", "question")).toBe(false)
  expect(turnHasCompletedTool(all, "nope", "question")).toBeUndefined()
  expect(turnHasCompletedTool([], "a3", "question")).toBeUndefined()
  expect(turnHasCompletedTool([msg("a0", "assistant", [toolPart("question", "completed")])], "a0", "question")).toBe(true)
})

// --- appendText --------------------------------------------------------------------------------

test("appendText handles string, array and output-only results", () => {
  expect(appendText({ content: "out" }, "w")).toEqual({ content: [{ type: "text", text: "out" }, { type: "text", text: "w" }] })
  expect(appendText({ content: [{ type: "text", text: "a" }], title: "t" }, "w")).toEqual({ content: [{ type: "text", text: "a" }, { type: "text", text: "w" }], title: "t" })
  expect(appendText({ output: { ok: true } }, "w")).toEqual({ output: { ok: true }, content: [{ type: "text", text: '{"ok":true}' }, { type: "text", text: "w" }] })
  expect(appendText({}, "w")).toEqual({ content: [{ type: "text", text: "w" }] })
})

// --- hooks via a mock ctx ----------------------------------------------------------------------

type Hooks = { before?: (e: any) => Promise<void>; after?: (e: any) => Promise<void> }
async function boot(options: any, directory = FOO, context?: (args: { sessionID: string }) => Promise<unknown>): Promise<Hooks> {
  const hooks: Hooks = {}
  const ctx: any = {
    options,
    location: { directory, project: { directory } },
    tool: { hook: async (name: string, fn: any) => { hooks[name === "execute.before" ? "before" : "after"] = fn } },
    session: { context: context ?? (async () => { throw new Error("no context in test") }) },
  }
  await plugin.setup(ctx)
  return hooks
}
const ev = (tool: string, input: any, extra: any = {}) => ({ tool, sessionID: "ses_x", messageID: "a3", id: "call_x", input: Object.freeze(input), ...extra })

test("before hook: refuse rules throw ruleText, warn-only configs register the after hook", async () => {
  const refuseOnly = await boot({ rules: [HOUSE[0]] })
  expect(refuseOnly.before).toBeDefined()
  expect(refuseOnly.after).toBeUndefined()
  await expect(refuseOnly.before!(ev("shell", sh("opencode upgrade")))).rejects.toThrow("rule `opencode-upgrade` refused `shell`")
  await expect(refuseOnly.before!(ev("shell", sh("ls")))).resolves.toBeUndefined()
  await expect(refuseOnly.before!(ev("execute", { code: "opencode upgrade" }))).resolves.toBeUndefined() // not a listed tool
  await expect(refuseOnly.before!(ev("shell", { command: 42 }))).resolves.toBeUndefined()
  const both = await boot({ rules: HOUSE })
  expect(both.after).toBeDefined()
})

test("before hook: guards still apply first and rules apply to non-file tools", async () => {
  const hooks = await boot({ guards: [{ owner: "~/dev/infra", paths: ["~/dev/infra"] }], rules: [{ id: "r", tools: ["webfetch"], match: "evil", message: "m" }] })
  await expect(hooks.before!(ev("edit", { path: h("dev/infra/x"), oldString: "a", newString: "b" }))).rejects.toThrow("owned by the project at")
  await expect(hooks.before!(ev("webfetch", { url: "http://evil" }))).rejects.toThrow("rule `r` refused `webfetch`")
  await expect(hooks.before!(ev("webfetch", { url: "http://good" }))).resolves.toBeUndefined()
})

test("before hook: a warn rule never throws", async () => {
  const hooks = await boot({ rules: [HOUSE[5]] })
  await expect(hooks.before!(ev("edit", { path: h("dev/foo/compose.yaml"), oldString: "a", newString: "b" }))).resolves.toBeUndefined()
})

test("after hook appends warnings to string, array and output-only results", async () => {
  const hooks = await boot({ rules: [HOUSE[5]] })
  const input = { path: h("dev/foo/compose.yaml"), oldString: "a", newString: "b" }
  const e1 = ev("edit", input, { status: "completed", result: { content: "edited" } })
  await hooks.after!(e1)
  expect(e1.result.content).toHaveLength(2)
  expect(e1.result.content[0]).toEqual({ type: "text", text: "edited" })
  expect(e1.result.content[1].text).toContain("rule `compose-deployer` warning for `edit`")
  expect(e1.result.content[1].text).toContain("PUT /api/services/:id/compose")
  const e2 = ev("edit", input, { status: "completed", result: { content: [{ type: "text", text: "a" }] } })
  await hooks.after!(e2)
  expect(e2.result.content).toHaveLength(2)
  const e3 = ev("edit", input, { status: "completed", result: { output: "ok" } })
  await hooks.after!(e3)
  expect(e3.result.content[0]).toEqual({ type: "text", text: '"ok"' })
  expect(e3.result.content[1].text).toContain("[project-guard] rule")
  const e4 = ev("edit", input, { status: "error", result: { content: "x" } })
  await hooks.after!(e4)
  expect(e4.result).toEqual({ content: "x" })
})

test("fault tolerance: a rejecting context lookup lets a conditional refusal through", async () => {
  const hooks = await boot({ rules: [HOUSE[4]] }, FOO, async () => { throw new Error("db down") })
  await expect(hooks.before!(ev("execute", { code: "await tools.bambuddy.execute_tool({name: \"print_library_file\"})" }))).resolves.toBeUndefined()
  const notFound = await boot({ rules: [HOUSE[4]] }, FOO, async () => [msg("u", "user")])
  await expect(notFound.before!(ev("execute", { code: "print_library_file" }))).resolves.toBeUndefined()
})

test("fault tolerance: an internal throw in rule evaluation lets the call through", async () => {
  const hooks = await boot({ rules: [{ id: "r", tools: ["shell"], match: "x", message: "m" }] })
  const poison = { get command(): string { throw new Error("boom") } }
  await expect(hooks.before!({ tool: "shell", sessionID: "s", messageID: "m", id: "c", input: poison })).resolves.toBeUndefined()
})

// --- house rules -------------------------------------------------------------------------------

const refusedBy = (id: string, tool: string, input: unknown) => expect(hitIds(house, tool, input)).toEqual([id])
const passes = (tool: string, input: unknown) => expect(hitIds(house, tool, input)).toEqual([])

test("house rule opencode-upgrade", () => {
  refusedBy("opencode-upgrade", "shell", sh("opencode upgrade"))
  refusedBy("opencode-upgrade", "shell", sh("npm i -g opencode"))
  refusedBy("opencode-upgrade", "bash", sh("npm install -g @opencode/cli-linux-x64"))
  refusedBy("opencode-upgrade", "shell", sh("curl -fsSL https://opencode.ai/install | bash"))
  passes("shell", sh("opencode attach http://127.0.0.1:4096"))
  passes("shell", sh("npm i -g pnpm"))
  passes("shell", sh("echo opencode upgraded"))
})

test("house rule cf-zerotrust", () => {
  refusedBy("cf-zerotrust", "shell", sh("ruby ~/dev/cf-zerotrust/sync.rb"))
  refusedBy("cf-zerotrust", "shell", sh("cd ~/dev/cf-zerotrust && bundle exec ruby sync.rb"))
  refusedBy("cf-zerotrust", "shell", sh("ruby sync.rb", "~/dev/cf-zerotrust"))
  passes("shell", sh("cat ~/dev/cf-zerotrust/README.md"))
  passes("shell", sh("ruby ~/dev/other/sync.rb"))
})

test("house rule dot-local", () => {
  refusedBy("dot-local", "shell", sh("curl http://pihole.local/admin"))
  refusedBy("dot-local", "shell", sh("ping bambuddy.local"))
  refusedBy("dot-local", "edit", { path: "config.yml", oldString: "a", newString: "https://gatus.local:8080" })
  refusedBy("dot-local", "write", { path: "config.yml", content: "host: printer.local" })
  passes("shell", sh("ls ~/.local/share"))
  passes("shell", sh("cat .env.local"))
  passes("shell", sh("docker compose -f compose.local.yml up"))
  passes("shell", sh("sudo systemctl restart rc.local"))
  passes("shell", sh("echo /etc/rc.local"))
  passes("write", { path: "notes.md", content: "# ~/.local/bin on PATH" })
})

test("house rule commit-attribution", () => {
  refusedBy("commit-attribution", "shell", sh(`git commit -m "fix" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`))
  refusedBy("commit-attribution", "shell", sh(`git -C ~/dev/x commit -am 'x\n\n🤖 Generated with Claude Code'`))
  passes("shell", sh(`git commit -m "fix login"`))
  passes("shell", sh("git log --grep=Co-Authored-By"))
})

test("house rule print-approval", async () => {
  const code = 'await tools.bambuddy.execute_tool({name: "print_library_file", arguments: {file_id: 1, printer_id: 2}})'
  refusedBy("print-approval", "execute", { code })
  passes("execute", { code: 'search({namespace: "bambuddy"})' })
  const turn = (parts: any[]) => [msg("u1", "user"), msg("a1", "assistant", parts), msg("a3", "assistant")]
  const without = await boot({ rules: [HOUSE[4]] }, FOO, async () => turn([{ type: "text", text: "queueing" }]))
  await expect(without.before!(ev("execute", { code }))).rejects.toThrow("rule `print-approval` refused `execute`")
  const withPending = await boot({ rules: [HOUSE[4]] }, FOO, async () => turn([toolPart("question", "pending")]))
  await expect(withPending.before!(ev("execute", { code }))).rejects.toThrow("[project-guard]")
  const withQuestion = await boot({ rules: [HOUSE[4]] }, FOO, async () => turn([toolPart("question", "completed")]))
  await expect(withQuestion.before!(ev("execute", { code }))).resolves.toBeUndefined()
  await expect(withQuestion.before!(ev("execute", { code: 'search({namespace: "bambuddy"})' }))).resolves.toBeUndefined()
})

test("house rule compose-deployer", async () => {
  const warned = async (dir: string, file: string) => {
    const hooks = await boot({ rules: [HOUSE[5]] }, dir)
    const e = ev("edit", { path: file, oldString: "a", newString: "b" }, { status: "completed", result: { content: "edited" } })
    await hooks.after!(e)
    return Array.isArray(e.result.content) && e.result.content.some((b: any) => typeof b.text === "string" && b.text.includes("rule `compose-deployer`"))
  }
  expect(await warned(FOO, h("dev/foo/compose.yaml"))).toBe(true)
  expect(await warned(FOO, h("dev/foo/docker-compose.override.yml"))).toBe(true)
  expect(await warned(h("dev/deployer"), h("dev/deployer/compose.yaml"))).toBe(false)
  expect(await warned(h("dev/deployer"), h("dev/foo/compose.yaml"))).toBe(false)
  expect(await warned(FOO, h("dev/foo/app.rb"))).toBe(false)
  expect(decideRules(house, FOO, "edit", { path: h("dev/foo/compose.yaml"), oldString: "a", newString: "b" }).map((x) => x.rule.kind)).toEqual(["warn"])
  // the patch form carries its paths in the patch text, one per line
  const patchText = `*** Begin Patch\n*** Update File: ${h("dev/foo/docker-compose.yml")}\n@@\n-a\n+b\n*** End Patch`
  expect(hitIds(house, "patch", { patchText })).toEqual(["compose-deployer"])
})
