import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.ts";
import { resolveZgCommand } from "../src/zg.ts";

type ExecResult = { stdout: string; stderr: string; code: number };
type Tool = {
  name: string;
  parameters: { properties: Record<string, unknown>; required?: string[] };
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};
type Command = { name: string; handler: (args: string, ctx: any) => Promise<void> };

function createHarness(options: {
  hasUI?: boolean;
  confirmed?: boolean;
  result?: ExecResult;
} = {}) {
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const calls: Array<[string, string[], Record<string, unknown>]> = [];
  const messages: Array<{ content: string; details: unknown }> = [];
  const confirmations: Array<[string, string]> = [];
  let confirmed = options.confirmed ?? true;
  const result = options.result ?? { stdout: "freshness: fresh\nsrc/theme.ts:12", stderr: "", code: 0 };

  extension({
    exec: async (command: string, args: string[], execOptions: Record<string, unknown>) => {
      calls.push([command, args, execOptions]);
      return result;
    },
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Omit<Command, "name">) => commands.set(name, { name, ...command }),
    sendMessage: (message: { content: string; details: unknown }) => messages.push(message),
    getCommands: () => [],
  } as any);

  return {
    tools,
    commands,
    calls,
    messages,
    confirmations,
    setConfirmed(value: boolean) {
      confirmed = value;
    },
    ctx: {
      cwd: "/workspace",
      hasUI: options.hasUI ?? true,
      ui: {
        confirm: async (title: string, message: string) => {
          confirmations.push([title, message]);
          return confirmed;
        },
        input: async () => undefined,
        notify: () => {},
        select: async () => undefined,
      },
    },
  };
}

function tool(harness: ReturnType<typeof createHarness>, name: string): Tool {
  const registered = harness.tools.get(name);
  assert.ok(registered, `${name} should be registered`);
  return registered;
}

test("extension exposes the documented tool and command surface", () => {
  const harness = createHarness();

  assert.deepEqual([...harness.tools.keys()], [
    "zvec_grep_search",
    "zvec_grep_rg",
    "zvec_grep_index_status",
    "zvec_grep_index",
    "zvec_grep_index_drop",
  ]);
  assert.deepEqual([...harness.commands.keys()], [
    "commands",
    "zg-query",
    "zg-rg",
    "zg-status",
    "zg-index",
    "zg-index-drop",
  ]);

  const search = tool(harness, "zvec_grep_search");
  assert.ok(search.parameters.required?.includes("root"));
  assert.equal((search.parameters.properties.limit as { maximum: number }).maximum, 50);
  assert.deepEqual((search.parameters.properties.freshness as { enum: string[] }).enum, ["eventual", "wait_for_fresh"]);
  assert.ok("checkReady" in tool(harness, "zvec_grep_index_status").parameters.properties);
});

test("indexed search executes in the requested root and rejects invalid inputs", async () => {
  const harness = createHarness();
  const search = tool(harness, "zvec_grep_search");
  const controller = new AbortController();

  const result = await search.execute("call", {
    root: "/project",
    query: "authentication flow",
    fts: ["AuthService"],
    vector: ["where access is denied"],
    fuse: true,
    globs: ["src/**"],
    fileTypes: ["ts"],
    freshness: "wait_for_fresh",
  }, controller.signal, undefined, harness.ctx);

  const zgLaunch = resolveZgCommand();
  assert.equal(result.content[0]?.text, "freshness: fresh\nsrc/theme.ts:12");
  assert.deepEqual(harness.calls, [[zgLaunch.command, [
    ...zgLaunch.prefixArgs,
    "query", "--mode", "direct", "authentication flow", "--fts", "AuthService", "--vector", "where access is denied", "--fuse", "--limit", "8",
    "--glob", "src/**", "--type", "ts", "--refresh", "wait",
  ], { cwd: "/project", signal: controller.signal, timeout: 600_000 }]]);

  await assert.rejects(
    search.execute("call", { root: "relative", query: "theme" }, undefined, undefined, harness.ctx),
    /absolute workspace path/,
  );
  await assert.rejects(
    search.execute("call", { root: "/project" }, undefined, undefined, harness.ctx),
    /At least one of query, queries, fts, or vector is required/,
  );
});

test("managed rg is shell-free, handles a bounded command, and rejects unsupported pipelines", async () => {
  const harness = createHarness({ result: { stdout: "one\ntwo\nthree", stderr: "", code: 0 } });
  const rg = tool(harness, "zvec_grep_rg");

  const result = await rg.execute("call", {
    root: "/project",
    command: "rg -n -F 'loadTheme' -g '*.ts' src | head -2",
  }, undefined, undefined, harness.ctx);

  const zgLaunch = resolveZgCommand();
  assert.equal(result.content[0]?.text, "one\ntwo");
  assert.deepEqual(harness.calls[0]?.slice(0, 2), [zgLaunch.command, [...zgLaunch.prefixArgs, "query", "--mode", "direct", "--rg", "-n", "-F", "loadTheme", "-g", "*.ts", "src"]]);
  await assert.rejects(
    rg.execute("call", { root: "/project", command: "rg theme | sort" }, undefined, undefined, harness.ctx),
    /head -N/,
  );
});

test("status passes check-ready and does not lose the Pi execution context", async () => {
  const harness = createHarness({ result: { stdout: "ready", stderr: "", code: 0 } });
  const status = tool(harness, "zvec_grep_index_status");

  const result = await status.execute("call", { root: "/project", checkReady: true }, undefined, undefined, harness.ctx);

  const zgLaunch = resolveZgCommand();
  assert.equal(result.content[0]?.text, "ready");
  assert.deepEqual(harness.calls[0], [zgLaunch.command, [...zgLaunch.prefixArgs, "status", "--mode", "direct", "--check-ready"], {
    cwd: "/project", signal: undefined, timeout: 600_000,
  }]);
});

test("check-ready surfaces the CLI diagnostic when an index is not ready", async () => {
  const harness = createHarness({ result: { stdout: "", stderr: "Workspace index is not configured", code: 1 } });

  await assert.rejects(
    tool(harness, "zvec_grep_index_status").execute("call", { root: "/project", checkReady: true }, undefined, undefined, harness.ctx),
    /Workspace index is not configured/,
  );
});

test("index tools require interactive visible confirmation before mutating an index", async () => {
  const nonInteractive = createHarness({ hasUI: false });
  await assert.rejects(
    tool(nonInteractive, "zvec_grep_index").execute("call", { root: "/project" }, undefined, undefined, nonInteractive.ctx),
    /interactive Pi session/,
  );
  assert.equal(nonInteractive.calls.length, 0);

  const harness = createHarness({ confirmed: false, result: { stdout: "indexed", stderr: "", code: 0 } });
  const index = tool(harness, "zvec_grep_index");
  const drop = tool(harness, "zvec_grep_index_drop");

  const cancelled = await index.execute("call", { root: "/project", rebuild: true }, undefined, undefined, harness.ctx);
  assert.equal(cancelled.content[0]?.text, "zg index was cancelled.");
  assert.equal(harness.calls.length, 0);
  assert.match(harness.confirmations[0]?.[1] ?? "", /remote embedding model/);

  harness.setConfirmed(true);
  await index.execute("call", {
    root: "/project",
    embedding: "local/potion-code-16m-v2",
    rebuild: true,
    maxDepth: 2,
    allowRemote: true,
  }, undefined, undefined, harness.ctx);
  await drop.execute("call", { root: "/project" }, undefined, undefined, harness.ctx);

  const zgLaunch = resolveZgCommand();
  assert.deepEqual(harness.calls.map((call) => call[1]), [
    [...zgLaunch.prefixArgs, "index", "--mode", "direct", "--embedding", "local/potion-code-16m-v2", "--rebuild", "--max-depth", "2", "--allow-remote"],
    [...zgLaunch.prefixArgs, "index", "--mode", "direct", "--drop", "--yes"],
  ]);
  assert.equal(harness.confirmations.length, 3);
});

test("tool output remains bounded for Pi context", async () => {
  const output = Array.from({ length: 251 }, (_, index) => `line ${index + 1}`).join("\n");
  const harness = createHarness({ result: { stdout: output, stderr: "", code: 0 } });
  const result = await tool(harness, "zvec_grep_search").execute(
    "call",
    { root: "/project", query: "theme" },
    undefined,
    undefined,
    harness.ctx,
  );

  const text = result.content[0]?.text ?? "";
  assert.match(text, /zg output truncated to 247 of 251 lines/);
  assert.ok(Buffer.byteLength(text) <= 16 * 1024);
  assert.ok(text.split("\n").length <= 250);

  const bytes = createHarness({ result: { stdout: "😀".repeat(5_000), stderr: "", code: 0 } });
  const byteResult = await tool(bytes, "zvec_grep_search").execute(
    "call",
    { root: "/project", query: "theme" },
    undefined,
    undefined,
    bytes.ctx,
  );
  const byteText = byteResult.content[0]?.text ?? "";
  assert.match(byteText, /zg output truncated/);
  assert.ok(Buffer.byteLength(byteText) <= 16 * 1024);
});

test("slash commands delegate to the same direct CLI forms", async () => {
  const harness = createHarness({ result: { stdout: "ok", stderr: "", code: 0 } });

  await harness.commands.get("zg-query")?.handler("theme persistence", harness.ctx);
  await harness.commands.get("zg-rg")?.handler("rg -n theme src", harness.ctx);
  await harness.commands.get("zg-status")?.handler("/project --check-ready", harness.ctx);

  const zgLaunch = resolveZgCommand();
  assert.deepEqual(harness.calls.map((call) => call[1]), [
    [...zgLaunch.prefixArgs, "query", "--mode", "direct", "theme persistence", "--limit", "8"],
    [...zgLaunch.prefixArgs, "query", "--mode", "direct", "--rg", "-n", "theme", "src"],
    [...zgLaunch.prefixArgs, "status", "--mode", "direct", "--check-ready"],
  ]);
  assert.deepEqual(harness.calls.map((call) => call[2].cwd), ["/workspace", "/workspace", "/project"]);
  assert.equal(harness.messages.length, 3);
});
