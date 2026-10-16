// Type-only import: erased at runtime, so the plugin directory needs no node_modules of its own.
import type { Plugin } from "@opencode/plugin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Refuses file and shell writes into another project's territory from a session that is not rooted
// there. A guard names an owner directory and the paths it owns (for example an infrastructure
// project whose rendered config of other services must only be changed from that project); every
// other session gets a refusal and, optionally, a custom `message` telling the model what to do
// instead. Without `guards` in the options the plugin is inert.
//
//   - owner sessions (cwd under the guard's owner root) are never blocked for that guard.
//   - edit/write/patch: the target path is resolved and compared to the guarded roots.
//   - shell/bash: conservative write-intent detection on the command string. Reads always pass;
//     when unsure, the call passes (false negatives are acceptable, false positives are not).
//   - any internal fault logs `[project-guard] …` and lets the call through.

export type Guard = { owner: string; paths: string[]; message?: string }

// A rule is a pattern check on what a tool call carries (the shell command, the written path or
// content, Code Mode code, …). `refuse` throws before the call runs; `warn` lets it run and appends
// the message to the tool result. Rules are independent of guards and apply to any tool they list.
export type RuleKind = "refuse" | "warn"
export type RuleField = "command" | "path" | "content" | "code" | "name" | "input"
export type Rule = {
  id: string
  kind: RuleKind
  tools: string[]
  match: RegExp[]
  except?: RegExp[]
  on?: RuleField[]
  message: string
  allow_from?: string[]
  unless_turn_tool?: string
}
export type Options = { guards: Guard[]; rules: Rule[]; debug: boolean }

// No guards by default: every guard comes from `options.guards`.
export const DEFAULT_GUARDS: Guard[] = []

export const FILE_TOOLS = new Set(["edit", "write", "patch"])
export const SHELL_TOOLS = new Set(["shell", "bash"])
export const RULE_FIELDS: ReadonlySet<string> = new Set<RuleField>(["command", "path", "content", "code", "name", "input"])

export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

// `/body/flags` becomes `new RegExp(body, flags)`; anything else is a plain pattern with no flags.
// Returns undefined for an invalid pattern.
export function parseRegex(s: string): RegExp | undefined {
  const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(s)
  try {
    return m ? new RegExp(m[1], m[2]) : new RegExp(s)
  } catch {
    return undefined
  }
}

function regexList(v: unknown): RegExp[] | undefined {
  const items = typeof v === "string" ? [v] : Array.isArray(v) ? v : undefined
  if (!items) return undefined
  const out: RegExp[] = []
  for (const item of items) {
    if (typeof item !== "string") return undefined
    const re = parseRegex(item)
    if (!re) return undefined
    out.push(re)
  }
  return out
}

// Validate one raw rule; the reason string explains a drop.
export function resolveRule(raw: any): { rule?: Rule; reason?: string } {
  if (!raw || typeof raw !== "object") return { reason: "not an object" }
  if (typeof raw.id !== "string" || raw.id.length === 0) return { reason: "missing id" }
  const id: string = raw.id
  if (!Array.isArray(raw.tools) || raw.tools.length === 0 || !raw.tools.every((t: unknown) => typeof t === "string" && t.length > 0)) return { reason: `rule ${id}: tools must be a non-empty list of names` }
  if (typeof raw.message !== "string" || raw.message.length === 0) return { reason: `rule ${id}: missing message` }
  const kind: RuleKind = raw.kind === undefined ? "refuse" : raw.kind
  if (kind !== "refuse" && kind !== "warn") return { reason: `rule ${id}: kind must be "refuse" or "warn"` }
  const match = regexList(raw.match)
  if (!match || match.length === 0) return { reason: `rule ${id}: match must be a valid regex or list of regexes` }
  const rule: Rule = { id, kind, tools: [...raw.tools], match, message: raw.message }
  if (raw.except !== undefined) {
    const except = regexList(raw.except)
    if (!except) return { reason: `rule ${id}: except must be a valid regex or list of regexes` }
    rule.except = except
  }
  if (raw.on !== undefined) {
    if (!Array.isArray(raw.on) || raw.on.length === 0 || !raw.on.every((f: unknown) => typeof f === "string" && RULE_FIELDS.has(f))) return { reason: `rule ${id}: on must list fields out of ${[...RULE_FIELDS].join("|")}` }
    rule.on = [...raw.on]
  }
  if (raw.allow_from !== undefined) {
    if (!Array.isArray(raw.allow_from) || !raw.allow_from.every((d: unknown) => typeof d === "string")) return { reason: `rule ${id}: allow_from must be a list of directories` }
    rule.allow_from = raw.allow_from.map(expandHome)
  }
  if (raw.unless_turn_tool !== undefined) {
    if (typeof raw.unless_turn_tool !== "string" || raw.unless_turn_tool.length === 0) return { reason: `rule ${id}: unless_turn_tool must be a tool name` }
    rule.unless_turn_tool = raw.unless_turn_tool
  }
  return { rule }
}

export function resolveOptions(raw: Readonly<Record<string, any>> = {}, warn: (msg: string) => void = (m) => console.error(`[project-guard] ${m}`)): Options {
  const rawGuards = Array.isArray(raw.guards) ? (raw.guards as Guard[]) : DEFAULT_GUARDS
  const guards = rawGuards
    .filter((g) => g && typeof g.owner === "string" && Array.isArray(g.paths))
    .map((g) => ({
      owner: expandHome(g.owner),
      paths: g.paths.filter((p) => typeof p === "string").map(expandHome),
      ...(typeof g.message === "string" && g.message.length > 0 ? { message: g.message } : {}),
    }))
  const rules: Rule[] = []
  if (raw.rules !== undefined && !Array.isArray(raw.rules)) warn("options.rules must be an array, ignoring it")
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    const { rule, reason } = resolveRule(r)
    if (rule) rules.push(rule)
    else warn(`dropping invalid rule (${reason})`)
  }
  return { guards, rules, debug: raw.debug === true }
}

// Canonical absolute form: realpath when the path (or its nearest existing ancestor) exists, so a
// symlinked checkout compares equal to its target; plain resolve otherwise.
export function canonical(p: string, base: string = process.cwd()): string {
  const abs = path.resolve(base, expandHome(p))
  let probe = abs
  const rest: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(probe)
      return rest.length ? path.join(real, ...rest.reverse()) : real
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return abs
      rest.push(path.basename(probe))
      probe = parent
    }
  }
}

export function isUnder(p: string, root: string): boolean {
  const a = canonical(p)
  const r = canonical(root)
  if (a === r) return true
  const rel = path.relative(r, a)
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)
}

// --- shell command analysis -------------------------------------------------------------------

export type ShellWrite = { target: string; cwd: string }

// Split a command line into words, honouring quotes. Not a full shell parser: `$(…)`, heredocs and
// escapes are left as opaque words, which only ever makes the detection miss (never block).
export function tokenize(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let has = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i]
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (cur.length || has) out.push(cur)
      cur = ""
      has = false
      continue
    }
    cur += c
  }
  if (cur.length || has) out.push(cur)
  return out
}

// Split on `&&`, `;`, `||`, `|` outside quotes. `|` splits too: `cat x | tee y` must see `tee y`.
export function splitSegments(cmd: string): string[] {
  const segs: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i]
      continue
    }
    if (c === "\n" || c === ";") {
      segs.push(cur)
      cur = ""
      continue
    }
    if ((c === "&" || c === "|") && cmd[i + 1] === c) {
      segs.push(cur)
      cur = ""
      i++
      continue
    }
    if (c === "|") {
      segs.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  segs.push(cur)
  return segs.map((s) => s.trim()).filter((s) => s.length > 0)
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "builtin", "exec", "nice", "ionice", "doas"])
// Commands whose positional args are the written paths (every non-flag argument).
const WRITE_ALL_ARGS = new Set(["rm", "mkdir", "touch", "truncate", "rmdir", "unlink", "shred"])
// Commands whose written paths are every non-flag argument after the first (mode/owner/source).
const WRITE_AFTER_FIRST = new Set(["chmod", "chown", "chgrp"])
const GIT_WRITE = new Set([
  "add", "commit", "checkout", "switch", "reset", "rebase", "merge", "rm", "mv", "stash", "push",
  "pull", "cherry-pick", "revert", "am", "apply", "clean", "restore", "tag", "branch",
])
const COMPOSE_WRITE = new Set(["up", "down", "restart", "stop", "start", "rm", "build", "pull", "create", "kill", "run", "exec", "cp"])

function positional(args: string[]): string[] {
  return args.filter((a) => a !== "--" && !a.startsWith("-"))
}

function stripWrappers(words: string[]): string[] {
  let i = 0
  while (i < words.length && (ENV_ASSIGN.test(words[i]) || WRAPPERS.has(words[i]))) {
    if (words[i] === "sudo" || words[i] === "env" || words[i] === "nice") {
      // skip their own flags
      i++
      while (i < words.length && words[i].startsWith("-")) i++
      continue
    }
    i++
  }
  return words.slice(i)
}

// Paths one shell segment writes to, relative to `cwd`. Pure; never throws on odd input.
export function writesOfSegment(seg: string, cwd: string): ShellWrite[] {
  const writes: ShellWrite[] = []
  const add = (t: string | undefined) => {
    if (t && !t.startsWith("-") && !t.startsWith("$")) writes.push({ target: t, cwd })
  }

  // Output redirections: `> f`, `>> f`, `2> f`, `&> f`, `>f`.
  const redir = /(?:^|[\s\d&])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g
  for (const m of seg.matchAll(redir)) {
    const raw = m[1].replace(/^["']|["']$/g, "")
    if (raw !== "/dev/null" && !/^&\d/.test(raw)) add(raw)
  }

  const words = stripWrappers(tokenize(seg.replace(/\d?>{1,2}\s*\S+/g, " ")))
  if (words.length === 0) return writes
  const cmd = path.basename(words[0])
  const args = words.slice(1)

  if (cmd === "tee") {
    positional(args).forEach(add)
  } else if (WRITE_ALL_ARGS.has(cmd)) {
    positional(args).forEach(add)
  } else if (WRITE_AFTER_FIRST.has(cmd)) {
    positional(args).slice(1).forEach(add)
  } else if (cmd === "sed" && args.some((a) => a === "-i" || /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) {
    // every positional after the expression (or after -e/-f/--expression args) is a written file
    const files: string[] = []
    let exprSeen = args.some((a) => a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"))
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
        i++
        continue
      }
      if (a.startsWith("-")) continue
      if (!exprSeen) {
        exprSeen = true
        continue
      }
      files.push(a)
    }
    files.forEach(add)
  } else if (cmd === "perl" && args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === "-e" || a === "-E") {
        i++
        continue
      }
      if (a.startsWith("-")) continue
      files.push(a)
    }
    files.forEach(add)
  } else if (cmd === "mv" || cmd === "cp" || cmd === "rsync" || cmd === "install") {
    const pos = positional(args)
    if (pos.length >= 2) add(pos[pos.length - 1])
    if (cmd === "mv") pos.slice(0, -1).forEach(add) // moving a guarded file away is a write to it
  } else if (cmd === "ln") {
    const pos = positional(args)
    if (pos.length >= 1) add(pos[pos.length - 1])
  } else if (cmd === "git") {
    let gitCwd = cwd
    let i = 0
    for (; i < args.length; i++) {
      const a = args[i]
      if (a === "-C" && args[i + 1]) {
        gitCwd = path.resolve(cwd, expandHome(args[++i]))
        continue
      }
      if (a === "-c" || a === "--git-dir" || a === "--work-tree") {
        i++
        continue
      }
      if (a.startsWith("-")) continue
      break
    }
    const sub = args[i]
    if (sub && GIT_WRITE.has(sub)) writes.push({ target: gitCwd, cwd })
  } else if (cmd === "docker" || cmd === "docker-compose" || cmd === "podman") {
    let rest = args
    if (cmd === "docker" || cmd === "podman") {
      const idx = rest.indexOf("compose")
      if (idx < 0) return writes
      rest = rest.slice(idx + 1)
    }
    const files: string[] = []
    let sub: string | undefined
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if ((a === "-f" || a === "--file") && rest[i + 1]) {
        files.push(rest[++i])
        continue
      }
      if (a.startsWith("--file=")) {
        files.push(a.slice(7))
        continue
      }
      if (a === "-p" || a === "--project-name" || a === "--project-directory" || a === "--profile" || a === "--env-file") {
        if (a === "--project-directory" && rest[i + 1]) files.push(rest[i + 1])
        i++
        continue
      }
      if (a.startsWith("-")) continue
      sub = a
      break
    }
    if (sub && COMPOSE_WRITE.has(sub)) {
      if (files.length) files.forEach(add)
      else writes.push({ target: cwd, cwd })
    }
  }
  return writes
}

// Every write target of a whole command line, with `cd` tracked across segments.
export function shellWrites(command: string, cwd: string): ShellWrite[] {
  const out: ShellWrite[] = []
  let cur = cwd
  for (const seg of splitSegments(command)) {
    const words = stripWrappers(tokenize(seg))
    if (words[0] === "cd" || words[0] === "pushd") {
      const t = positional(words.slice(1))[0]
      cur = t ? path.resolve(cur, expandHome(t)) : os.homedir()
      continue
    }
    out.push(...writesOfSegment(seg, cur))
  }
  return out
}

// --- decision --------------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

// Absolute paths a tool call writes to. `directory` is the session cwd; `workdir` on the input wins.
export function targetsOf(tool: string, input: unknown, directory: string = process.cwd()): string[] {
  if (!input || typeof input !== "object") return []
  const inp = input as Record<string, unknown>
  const base = str(inp.workdir) ? path.resolve(directory, expandHome(str(inp.workdir)!)) : directory
  if (FILE_TOOLS.has(tool)) {
    const targets: string[] = []
    for (const key of ["filePath", "path", "file", "file_path"]) {
      const v = str(inp[key])
      if (v) targets.push(path.resolve(base, expandHome(v)))
    }
    // the patch tool carries its files inside the patch text (`*** Update File: path`)
    const text = str(inp.patchText) ?? str(inp.patch)
    if (text) {
      for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) targets.push(path.resolve(base, expandHome(m[1].trim())))
      for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) targets.push(path.resolve(base, expandHome(m[1].trim())))
    }
    return targets
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = str(inp.command)
    if (!command) return []
    return shellWrites(command, base).map((w) => path.resolve(w.cwd, expandHome(w.target)))
  }
  return []
}

// Refusal text: what was refused and why, then the guard's own protocol (`message`) or a generic
// instruction. `{owner}`, `{target}`, `{tool}` and `{directory}` in a custom message are substituted.
export function rejection(tool: string, target: string, guard: Guard, directory: string): string {
  const head = `[project-guard] \`${tool}\` refused: ${target} is owned by the project at ${guard.owner}, and this session is rooted at ${directory}. `
  const body =
    guard.message?.replace(/\{(owner|target|tool|directory)\}/g, (_m, k: string) => ({ owner: guard.owner, target, tool, directory })[k] ?? "") ??
    "Do not work around it. Changes to this territory are made only from a session rooted in the owning project (or through the API that project exposes); " +
      "report what you needed to the user instead and let them decide. This call will not be accepted again from this session."
  return head + body
}

export type Decision = { message: string; target: string; owner: string } | undefined

// Rejection (message + what/why) or undefined when the call passes.
export function decideFull(opts: Options, directory: string, tool: string, input: unknown): Decision {
  if (!FILE_TOOLS.has(tool) && !SHELL_TOOLS.has(tool)) return
  const targets = targetsOf(tool, input, directory)
  if (targets.length === 0) return
  for (const guard of opts.guards) {
    if (isUnder(directory, guard.owner)) continue // owner session
    for (const target of targets) {
      const hit = guard.paths.find((root) => isUnder(target, root))
      if (hit) return { message: rejection(tool, target, guard, directory), target, owner: guard.owner }
    }
  }
}

export function decide(opts: Options, directory: string, tool: string, input: unknown): string | undefined {
  return decideFull(opts, directory, tool, input)?.message
}

// --- rules -------------------------------------------------------------------------------------

// What a rule's patterns are tested against, per tool. Only fields that exist are returned.
export function subjectsOf(tool: string, input: unknown, directory: string): Partial<Record<RuleField, string>> {
  const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  if (SHELL_TOOLS.has(tool)) {
    const command = str(inp.command)
    if (!command) return {}
    const workdir = str(inp.workdir)
    return { command: workdir ? `cd ${workdir} && ${command}` : command }
  }
  if (FILE_TOOLS.has(tool)) {
    const out: Partial<Record<RuleField, string>> = {}
    const targets = targetsOf(tool, input, directory)
    if (targets.length) out.path = targets.join("\n")
    const content = str(inp.content) ?? str(inp.newString) ?? str(inp.patchText) ?? str(inp.patch)
    if (content) out.content = content
    return out
  }
  if (tool === "execute") {
    const code = str(inp.code)
    return code ? { code } : {}
  }
  return { name: tool, input: JSON.stringify(input) ?? "" }
}

export type RuleHit = { rule: Rule; field: RuleField; match: string; tool: string }

// First counting match of `rule` in the subjects: a match whose text is covered by an `except`
// pattern is skipped. Regexes are copied with the `g` flag so the configured objects keep no state.
export function firstMatch(rule: Rule, subjects: Partial<Record<RuleField, string>>): { field: RuleField; match: string } | undefined {
  const fields = (rule.on ?? (Object.keys(subjects) as RuleField[])).filter((f) => subjects[f] !== undefined)
  for (const field of fields) {
    const text = subjects[field]!
    for (const re of rule.match) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
      for (const m of text.matchAll(g)) {
        const hit = m[0]
        if (rule.except?.some((ex) => ex.test(hit))) continue
        return { field, match: hit }
      }
    }
  }
}

// Every rule hit for a tool call: rule lists the tool, the session is not under an `allow_from`
// root, and a pattern matched. `unless_turn_tool` is not evaluated here (it needs the session).
export function decideRules(opts: Options, directory: string, tool: string, input: unknown): RuleHit[] {
  const hits: RuleHit[] = []
  const rules = opts.rules.filter((r) => r.tools.includes(tool))
  if (rules.length === 0) return hits
  const subjects = subjectsOf(tool, input, directory)
  for (const rule of rules) {
    if (rule.allow_from?.some((root) => isUnder(directory, root))) continue
    const m = firstMatch(rule, subjects)
    if (m) hits.push({ rule, field: m.field, match: m.match, tool })
  }
  return hits
}

export function ruleText(hit: RuleHit, directory: string): string {
  const { rule, field, match, tool } = hit
  const vars: Record<string, string> = { id: rule.id, tool, match, directory, subject: field }
  const message = rule.message.replace(/\{(id|tool|match|directory|subject)\}/g, (_m, k: string) => vars[k] ?? "")
  return `[project-guard] rule \`${rule.id}\` ${rule.kind === "refuse" ? "refused" : "warning for"} \`${tool}\`: matched "${match}" in ${field}. ${message}`
}

type ContextPart = { type: string; name?: string; state?: { status?: string } }
type ContextMessage = { id: string; type: string; content?: ContextPart[] }

// Whether the turn that `messageID` belongs to (that message and every message back to, not
// including, the previous user message) carries a completed tool part named `toolName`.
// Undefined when the message is not in the context.
export function turnHasCompletedTool(messages: ContextMessage[], messageID: string, toolName: string): boolean | undefined {
  const idx = messages.findIndex((m) => m.id === messageID)
  if (idx < 0) return undefined
  for (let i = idx; i >= 0; i--) {
    const m = messages[i]
    if (i !== idx && m.type === "user") break
    for (const part of m.content ?? []) {
      if (part.type === "tool" && part.name === toolName && part.state?.status === "completed") return true
    }
  }
  return false
}

type TextBlock = { type: "text"; text: string }
type HookResult = { content?: string | unknown[]; output?: unknown; [k: string]: unknown }

// Same shape as the diagnostics plugin: text content becomes a block list, an array gets a block
// appended, otherwise the serialised output is the first block.
export function appendText(result: HookResult, text: string): HookResult {
  const block: TextBlock = { type: "text", text }
  if (typeof result.content === "string") return { ...result, content: [{ type: "text", text: result.content }, block] }
  if (Array.isArray(result.content)) return { ...result, content: [...result.content, block] }
  const output = result.output === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(result.output) }]
  return { ...result, content: [...output, block] }
}

const plugin: Plugin.Plugin = {
  id: "project-guard",
  async setup(ctx) {
    const log = (msg: string) => console.error(`[project-guard] ${msg}`)
    const opts = resolveOptions(ctx.options, log)
    const directory: string = ctx.location?.directory ?? process.cwd()
    const describe = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error))
    const hasRules = opts.rules.length > 0
    const hasWarnRules = opts.rules.some((r) => r.kind === "warn")

    // Drops the hits whose `unless_turn_tool` is satisfied. The session context is read only when a
    // hit carries that condition; a failed lookup passes the rule (fail open).
    const applyTurnCondition = async (hits: RuleHit[], sessionID: string, messageID: string): Promise<RuleHit[]> => {
      if (!hits.some((h) => h.rule.unless_turn_tool)) return hits
      let messages: ContextMessage[] | undefined
      try {
        messages = (await ctx.session.context({ sessionID })) as unknown as ContextMessage[]
      } catch (error) {
        log(`context lookup failed for ${sessionID}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return hits.filter((h) => {
        const tool = h.rule.unless_turn_tool
        if (!tool) return true
        const has = Array.isArray(messages) ? turnHasCompletedTool(messages, messageID, tool) : undefined
        if (has === undefined) {
          log(`rule ${h.rule.id}: turn-tool check unavailable, passing`)
          return false
        }
        return !has
      })
    }

    await ctx.tool.hook("execute.before", async (event) => {
      const guarded = FILE_TOOLS.has(event.tool) || SHELL_TOOLS.has(event.tool)
      if (!guarded && !hasRules) return
      // Anything unexpected in here lets the call through; only the deliberate refusal throws.
      let verdict: Decision
      let refusal: RuleHit | undefined
      try {
        if (guarded) {
          verdict = decideFull(opts, directory, event.tool, event.input)
          if (!verdict && opts.debug) {
            const targets = targetsOf(event.tool, event.input, directory)
            log(`allowed ${event.tool} ${targets.join(",") || "-"} from ${directory}`)
          }
        }
        if (!verdict && hasRules) {
          const hits = decideRules(opts, directory, event.tool, event.input).filter((h) => h.rule.kind === "refuse")
          refusal = (await applyTurnCondition(hits, event.sessionID, event.messageID))[0]
          if (!refusal && opts.debug) log(`allowed ${event.tool} (rules: ${hits.length ? "matched but conditionally passed" : "none matched"})`)
        }
      } catch (error) {
        log(`internal failure, letting ${event.tool} through: ${describe(error)}`)
        return
      }
      if (verdict) {
        log(`refused ${event.tool} ${verdict.target} from ${directory} (owner ${verdict.owner}, session ${event.sessionID})`)
        throw new Error(verdict.message)
      }
      if (refusal) {
        log(`refused ${event.tool} by rule ${refusal.rule.id} from ${directory} (session ${event.sessionID})`)
        throw new Error(ruleText(refusal, directory))
      }
    })

    if (!hasWarnRules) return
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      try {
        const hits = decideRules(opts, directory, event.tool, event.input).filter((h) => h.rule.kind === "warn")
        const warnings = await applyTurnCondition(hits, event.sessionID, event.messageID)
        if (warnings.length === 0) {
          if (opts.debug && hits.length === 0) log(`allowed ${event.tool} (rules: none matched)`)
          return
        }
        let result = event.result as HookResult
        for (const hit of warnings) {
          result = appendText(result, ruleText(hit, directory))
          log(`warned ${event.tool} by rule ${hit.rule.id} from ${directory}`)
        }
        event.result = result as typeof event.result
      } catch (error) {
        log(`internal failure, letting ${event.tool} through: ${describe(error)}`)
      }
    })
  },
}

export default plugin
