// Type-only import: Bun resolves bare specifiers from the symlink's real path, where no node_modules exists.
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
export type Options = { guards: Guard[]; debug: boolean }

// No guards by default: every guard comes from `options.guards`.
export const DEFAULT_GUARDS: Guard[] = []

export const FILE_TOOLS = new Set(["edit", "write", "patch"])
export const SHELL_TOOLS = new Set(["shell", "bash"])

export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

export function resolveOptions(raw: Readonly<Record<string, any>> = {}): Options {
  const rawGuards = Array.isArray(raw.guards) ? (raw.guards as Guard[]) : DEFAULT_GUARDS
  const guards = rawGuards
    .filter((g) => g && typeof g.owner === "string" && Array.isArray(g.paths))
    .map((g) => ({
      owner: expandHome(g.owner),
      paths: g.paths.filter((p) => typeof p === "string").map(expandHome),
      ...(typeof g.message === "string" && g.message.length > 0 ? { message: g.message } : {}),
    }))
  return { guards, debug: raw.debug === true }
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

const plugin: Plugin.Plugin = {
  id: "project-guard",
  async setup(ctx) {
    const opts = resolveOptions(ctx.options)
    const log = (msg: string) => console.error(`[project-guard] ${msg}`)
    const directory: string = ctx.location?.directory ?? process.cwd()

    await ctx.tool.hook("execute.before", async (event) => {
      if (!FILE_TOOLS.has(event.tool) && !SHELL_TOOLS.has(event.tool)) return
      // Anything unexpected in here lets the call through; only the deliberate refusal throws.
      let verdict: Decision
      try {
        verdict = decideFull(opts, directory, event.tool, event.input)
        if (!verdict && opts.debug) {
          const targets = targetsOf(event.tool, event.input, directory)
          log(`allowed ${event.tool} ${targets.join(",") || "-"} from ${directory}`)
        }
      } catch (error) {
        log(`internal failure, letting ${event.tool} through: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        return
      }
      if (verdict) {
        log(`refused ${event.tool} ${verdict.target} from ${directory} (owner ${verdict.owner}, session ${event.sessionID})`)
        throw new Error(verdict.message)
      }
    })
  },
}

export default plugin
