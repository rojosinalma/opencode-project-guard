import { expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import plugin, {
  decide,
  expandHome,
  isUnder,
  resolveOptions,
  shellWrites,
  splitSegments,
  targetsOf,
  tokenize,
} from "../index.ts"

const home = os.homedir()
const h = (p: string) => path.join(home, p)
const INFRA = h("dev/infra")
const OTHER = h("dev/other")
const GUARDED = ["dev/infra", "dev/infra-routes", "dev/infra-proxy", "dev/lab/network/dns", "dev/infra-auth", "dev/lab/tunnel"].map(h)
const GUARD = { owner: "~/dev/infra", paths: GUARDED.map((p) => p.replace(home, "~")) }
const opts = resolveOptions({ guards: [GUARD] })

const edit = (file: string, workdir?: string) => ({ path: file, oldString: "a", newString: "b", ...(workdir ? { workdir } : {}) })
const sh = (command: string, workdir?: string) => ({ command, ...(workdir ? { workdir } : {}) })

test("no options means no guards: the plugin is inert", () => {
  const bare = resolveOptions()
  expect(bare.guards).toEqual([])
  expect(bare.debug).toBe(false)
  expect(decide(bare, OTHER, "edit", edit(h("dev/infra/app.rb")))).toBeUndefined()
  expect(decide(bare, OTHER, "shell", sh("rm -rf ~/dev/infra"))).toBeUndefined()
  expect(resolveOptions({ guards: [] }).guards).toEqual([])
  expect(resolveOptions({ guards: [{ owner: 1, paths: [] }] }).guards).toEqual([])
})

test("configured guards resolve and ~ expands", () => {
  expect(opts.debug).toBe(false)
  expect(opts.guards).toHaveLength(1)
  expect(opts.guards[0].owner).toBe(INFRA)
  expect(opts.guards[0].paths).toEqual(GUARDED)
  expect(opts.guards[0].message).toBeUndefined()
  expect(expandHome("~/dev/x")).toBe(h("dev/x"))
  expect(expandHome("/abs")).toBe("/abs")
  const custom = resolveOptions({ guards: [{ owner: "~/dev/a", paths: ["~/dev/a", "/srv/b"] }], debug: true })
  expect(custom.guards[0]).toEqual({ owner: h("dev/a"), paths: [h("dev/a"), "/srv/b"] })
  expect(custom.debug).toBe(true)
})

test("refusal text is generic by default and uses the guard message with placeholders", () => {
  const generic = decide(opts, OTHER, "edit", edit(h("dev/infra/app.rb")))!
  expect(generic).toContain("[project-guard] `edit` refused")
  expect(generic).toContain(`owned by the project at ${INFRA}`)
  expect(generic).toContain("only from a session rooted in the owning project")
  const custom = resolveOptions({ guards: [{ ...GUARD, message: "File a request with {owner} for {target} ({tool})." }] })
  const msg = decide(custom, OTHER, "write", { path: h("dev/infra-routes/x.yaml"), content: "" })!
  expect(msg).toContain(`File a request with ${INFRA} for ${h("dev/infra-routes/x.yaml")} (write).`)
  expect(msg).not.toContain("owning project (or through")
})

test("isUnder", () => {
  expect(isUnder(h("dev/infra/app.rb"), INFRA)).toBe(true)
  expect(isUnder(INFRA, INFRA)).toBe(true)
  expect(isUnder(h("dev/infra-agent/x"), INFRA)).toBe(false)
  expect(isUnder(h("dev/other/x"), INFRA)).toBe(false)
})

test("owner session edits a guarded file", () => {
  expect(decide(opts, INFRA, "edit", edit(h("dev/infra/app.rb")))).toBeUndefined()
  expect(decide(opts, h("dev/infra/lib"), "write", { filePath: h("dev/infra-routes/config.yaml"), content: "" })).toBeUndefined()
})

test("non-owner edit/write/patch under every guarded path is refused", () => {
  for (const root of GUARDED) {
    for (const tool of ["edit", "write", "patch"]) {
      const msg = decide(opts, OTHER, tool, { filePath: path.join(root, "some/file.txt") })
      expect(msg).toContain("[project-guard]")
      expect(msg).toContain("owned by the project at")
      expect(msg).toContain(path.join(root, "some/file.txt"))
      expect(msg).toContain(`\`${tool}\` refused`)
    }
  }
  const patch = { patchText: `*** Begin Patch\n*** Update File: ${h("dev/infra-proxy/compose.yaml")}\n@@\n-a\n+b\n*** End Patch` }
  expect(decide(opts, OTHER, "patch", patch)).toContain("[project-guard]")
})

test("non-owner edit outside the guarded set passes", () => {
  expect(decide(opts, OTHER, "edit", edit(h("dev/other/app.rb")))).toBeUndefined()
  expect(decide(opts, OTHER, "write", { path: h("dev/infra-docs/x.md"), content: "" })).toBeUndefined()
  expect(decide(opts, OTHER, "read", { path: h("dev/infra/app.rb") })).toBeUndefined()
})

test("relative paths resolve against directory, then workdir", () => {
  expect(decide(opts, INFRA, "edit", edit("models/x.rb"))).toBeUndefined()
  expect(decide(opts, OTHER, "edit", edit("models/x.rb", INFRA))).toContain("[project-guard]")
  expect(decide(opts, OTHER, "edit", edit("models/x.rb"))).toBeUndefined()
  expect(targetsOf("edit", edit("models/x.rb", "~/dev/infra"), OTHER)).toEqual([h("dev/infra/models/x.rb")])
})

test("tokenize / splitSegments", () => {
  expect(tokenize(`sed -i 's/a/b/' "x y"`)).toEqual(["sed", "-i", "s/a/b/", "x y"])
  expect(splitSegments("cd a && b; c || d | e")).toEqual(["cd a", "b", "c", "d", "e"])
  expect(splitSegments(`echo "a && b"`)).toEqual([`echo "a && b"`])
})

const refused = (cmd: string, workdir?: string) => expect(decide(opts, OTHER, "shell", sh(cmd, workdir))).toContain("[project-guard]")
const allowed = (cmd: string, workdir?: string) => expect(decide(opts, OTHER, "shell", sh(cmd, workdir))).toBeUndefined()

test("shell writes are refused", () => {
  refused("sed -i s/a/b/ ~/dev/infra/app.rb")
  refused("echo x > ~/dev/infra-routes/config.yaml")
  refused("echo x >> ~/dev/infra-routes/config.yaml")
  refused("cd ~/dev/infra-proxy && docker compose up -d")
  refused("cd ~/dev/infra-proxy && docker compose -f compose.yaml -f compose.443.yaml up -d")
  refused("docker compose -f ~/dev/infra-proxy/compose.yaml restart")
  refused("git -C ~/dev/infra-auth commit -m x")
  refused("git add .", INFRA)
  refused("rm -rf ~/dev/lab/network/dns/x.json")
  refused("mv ~/dev/other/x ~/dev/lab/tunnel/x")
  refused("cp a.txt ~/dev/infra/")
  refused("touch ~/dev/infra/VERSION; ls")
  refused("cat x | tee ~/dev/infra/config/seeds.yml")
  refused("perl -pi -e 's/a/b/' ~/dev/infra-routes/config.yaml")
  refused("chmod 600 ~/dev/infra-auth/.env")
  refused("ls && sed -i s/a/b/ config.yaml", h("dev/infra-routes"))
  expect(decide(opts, OTHER, "bash", { command: "echo x > ~/dev/infra-routes/config.yaml" })).toContain("[project-guard]")
})

test("shell reads and non-guarded writes pass", () => {
  allowed("cat ~/dev/infra/app.rb")
  allowed("rg foo ~/dev/infra-routes")
  allowed("docker compose -f ~/dev/infra-proxy/compose.yaml logs")
  allowed("docker compose -f ~/dev/infra-proxy/compose.yaml ps")
  allowed("git -C ~/dev/infra-auth log")
  allowed("git -C ~/dev/infra-auth diff; git -C ~/dev/infra status")
  allowed("git add .", h("dev/foo"))
  allowed("ruby ~/dev/infra/spec/foo_spec.rb")
  allowed("echo x > /tmp/opencode/out.txt")
  allowed("echo x > ~/dev/infra-docs/out.txt")
  allowed("sed -i s/a/b/ ~/dev/other/app.rb")
  allowed("cd ~/dev/infra && cat app.rb && git log")
  allowed("docker compose up -d", h("dev/other"))
  allowed("curl -k https://infra.example.test/api/services")
})

test("owner session shell writes pass", () => {
  expect(decide(opts, INFRA, "shell", sh("sed -i s/a/b/ app.rb"))).toBeUndefined()
  expect(decide(opts, INFRA, "shell", sh("docker compose -f ~/dev/infra-proxy/compose.yaml up -d"))).toBeUndefined()
  expect(shellWrites("cd ~/dev/infra-proxy && docker compose up -d", OTHER)).toEqual([{ target: h("dev/infra-proxy"), cwd: h("dev/infra-proxy") }])
})

test("setup registers a hook that refuses guarded edits and survives faults", async () => {
  let handler: ((event: any) => Promise<void>) | undefined
  const ctx: any = {
    options: { guards: [GUARD] },
    location: { directory: OTHER, project: { directory: OTHER } },
    tool: { hook: async (_name: string, fn: any) => { handler = fn } },
  }
  await plugin.setup(ctx)
  expect(handler).toBeDefined()
  const ev = (tool: string, input: any) => ({ tool, sessionID: "ses_x", messageID: "msg_x", id: "call_x", input: Object.freeze(input) })
  await expect(handler!(ev("edit", edit(h("dev/infra/app.rb"))))).rejects.toThrow("[project-guard]")
  await expect(handler!(ev("edit", edit(h("dev/other/app.rb"))))).resolves.toBeUndefined()
  await expect(handler!(ev("read", { path: h("dev/infra/app.rb") }))).resolves.toBeUndefined()
  await expect(handler!({ tool: "edit", sessionID: "s", messageID: "m", id: "c", input: null })).resolves.toBeUndefined()
  await expect(handler!({ tool: "shell", sessionID: "s", messageID: "m", id: "c", input: { command: 42 } })).resolves.toBeUndefined()
})

test("setup with an owner location lets guarded edits through", async () => {
  let handler: ((event: any) => Promise<void>) | undefined
  await plugin.setup({ options: { guards: [GUARD] }, location: { directory: INFRA }, tool: { hook: async (_n: string, fn: any) => { handler = fn } } } as any)
  await expect(handler!({ tool: "edit", sessionID: "s", messageID: "m", id: "c", input: edit(h("dev/infra-routes/config.yaml")) })).resolves.toBeUndefined()
})
