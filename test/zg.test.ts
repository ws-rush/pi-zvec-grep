import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndexArgs,
  buildRgArgs,
  buildSearchArgs,
  dropIndexZg,
  indexZg,
  parseRgCommand,
  resolveRoot,
  resolveZgCommand,
  rgZg,
  searchZg,
  statusZg,
} from "../src/zg.ts";

test("buildSearchArgs maps indexed query groups, scope, and freshness to zg query", () => {
  assert.deepEqual(
    buildSearchArgs({
      query: "authentication flow",
      queries: ["session restoration"],
      fts: ["AuthService", "ForbiddenError"],
      vector: ["where access is denied"],
      fuse: true,
      limit: 10,
      globs: ["src/**", "!src/generated/**"],
      insensitiveGlobs: ["**/*.TS"],
      fileTypes: ["ts"],
      excludedFileTypes: ["generated"],
      symbolTypes: ["class", "function"],
      preferSymbol: true,
      modifiedAfter: "2025-01-01",
      modifiedBefore: "2025-12-31",
      freshness: "eventual",
      autoUpdate: false,
    }),
    [
      "query", "--mode", "direct", "authentication flow", "--hybrid", "session restoration", "--fts", "AuthService", "--fts", "ForbiddenError",
      "--vector", "where access is denied", "--fuse", "--limit", "10", "--glob", "src/**", "--glob", "!src/generated/**",
      "--iglob", "**/*.TS", "--type", "ts", "--type-not", "generated", "--symbol-type", "class", "--symbol-type", "function",
      "--prefer-symbol", "--modified-after", "2025-01-01", "--modified-before", "2025-12-31", "--refresh", "off",
    ],
  );
});

test("buildSearchArgs requires a query group and caps limit", () => {
  assert.throws(() => buildSearchArgs({}), /At least one/);
  assert.throws(() => buildSearchArgs({ query: "theme", limit: 51 }), /1 to 50/);
  assert.throws(() => buildSearchArgs({ query: "theme", autoUpdate: true }), /forces direct CLI mode/);
  assert.deepEqual(
    buildSearchArgs({ fts: ["loadTheme"], freshness: "wait_for_fresh" }),
    ["query", "--mode", "direct", "--fts", "loadTheme", "--limit", "8", "--refresh", "wait"],
  );
  assert.deepEqual(
    buildSearchArgs({ vector: ["theme"], freshness: "eventual", autoUpdate: false }),
    ["query", "--mode", "direct", "--vector", "theme", "--limit", "8", "--refresh", "off"],
  );
});

test("buildRgArgs parses an rg command without invoking a shell", () => {
  assert.deepEqual(
    buildRgArgs({ command: "rg -n -F 'loadTheme' -g '*.ts' src" }),
    ["query", "--mode", "direct", "--rg", "-n", "-F", "loadTheme", "-g", "*.ts", "src"],
  );
  assert.deepEqual(parseRgCommand('rg -i -C 2 "dark mode" src | head -50'), {
    args: ["-i", "-C", "2", "dark mode", "src"],
    head: 50,
  });
  assert.deepEqual(parseRgCommand(String.raw`rg "\bTODO\b" src`), {
    args: ["\\bTODO\\b", "src"],
  });
  assert.throws(() => buildRgArgs({ command: "grep theme" }), /begin with rg/);
  assert.throws(() => buildRgArgs({ command: "rg theme | sort" }), /head -N/);
  assert.throws(() => buildRgArgs({ command: "rg 'unterminated" }), /unterminated quote/);
  assert.throws(() => buildRgArgs({ command: "rg theme | head -0" }), /at least one line/);
});

test("buildIndexArgs supports zg index flags and forces direct transport", () => {
  assert.deepEqual(
    buildIndexArgs({
      embedding: "local/potion-code-16m-v2",
      rebuild: true,
      resetPaths: true,
      globs: ["src/**"],
      insensitiveGlobs: ["**/*.TS"],
      fileTypes: ["ts"],
      excludedFileTypes: ["generated"],
      hidden: true,
      noIgnore: true,
      ignoreFiles: [".gitignore.local"],
      maxDepth: 4,
      maxFileSize: "1M",
      follow: true,
      apiKey: "secret",
      endpoint: "https://example.test",
      modelCache: "/tmp/models",
      device: "cpu",
      embeddingConcurrency: 3,
      allowRemote: true,
    }),
    [
      "index", "--mode", "direct", "--embedding", "local/potion-code-16m-v2", "--rebuild", "--reset-paths", "--glob", "src/**", "--iglob", "**/*.TS",
      "--type", "ts", "--type-not", "generated", "--hidden", "--no-ignore", "--ignore-file", ".gitignore.local", "--max-depth", "4",
      "--max-filesize", "1M", "--follow", "--api-key", "secret", "--endpoint", "https://example.test", "--model-cache", "/tmp/models",
      "--device", "cpu", "--embedding-concurrency", "3", "--allow-remote",
    ],
  );
});

test("resolveRoot accepts Pi @-prefixed paths", () => {
  assert.equal(resolveRoot("@packages/app", "/work/repo"), "/work/repo/packages/app");
});

test("searchZg executes zg query in the selected workspace", async () => {
  const calls: unknown[][] = [];
  const result = await searchZg(
    async (...args) => {
      calls.push(args);
      return { stdout: "freshness: fresh\nsrc/theme.ts:12", stderr: "", code: 0 };
    },
    { query: "theme persistence", root: "app", limit: 3 },
    "/work/repo",
  );

  const zgLaunch = resolveZgCommand();
  assert.deepEqual(calls, [[zgLaunch.command, [...zgLaunch.prefixArgs, "query", "--mode", "direct", "theme persistence", "--limit", "3"], {
    cwd: "/work/repo/app", signal: undefined, timeout: 600_000,
  }]]);
  assert.equal(result.output, "freshness: fresh\nsrc/theme.ts:12");
});

test("rgZg keeps managed rg exhaustive unless the caller requested head", async () => {
  const calls: unknown[][] = [];
  const result = await rgZg(
    async (...args) => {
      calls.push(args);
      return { stdout: "one\ntwo\nthree", stderr: "", code: 0 };
    },
    { command: "rg -n theme src | head -2" },
    "/work/repo",
  );

  const zgLaunch = resolveZgCommand();
  assert.deepEqual(calls[0]?.[1], [...zgLaunch.prefixArgs, "query", "--mode", "direct", "--rg", "-n", "theme", "src"]);
  assert.equal(result.output, "one\ntwo");
});

test("zg_rg returns no matches for ripgrep's empty exit code", async () => {
  const result = await rgZg(async () => ({ stdout: "", stderr: "", code: 1 }), { command: "rg missing" }, "/work/repo");
  assert.equal(result.output, "No matches.");
});

test("zg status, index, and index drop use their expected commands", async () => {
  const calls: unknown[][] = [];
  const execute = async (...args: any[]) => {
    calls.push(args);
    return { stdout: "ok", stderr: "", code: 0 };
  };
  await statusZg(execute, "app", "/work/repo");
  await statusZg(execute, { root: "app", checkReady: true }, "/work/repo");
  await indexZg(execute, { root: "app", rebuild: true }, "/work/repo");
  await dropIndexZg(execute, "app", "/work/repo");
  const zgLaunch = resolveZgCommand();
  assert.deepEqual(calls.map((call) => call[1]), [
    [...zgLaunch.prefixArgs, "status", "--mode", "direct"],
    [...zgLaunch.prefixArgs, "status", "--mode", "direct", "--check-ready"],
    [...zgLaunch.prefixArgs, "index", "--mode", "direct", "--rebuild"],
    [...zgLaunch.prefixArgs, "index", "--mode", "direct", "--drop", "--yes"],
  ]);
});

test("zg failures include command output and launch errors", async () => {
  await assert.rejects(
    searchZg(async () => ({ stdout: "", stderr: "No index exists", code: 2 }), { query: "theme persistence" }, "/work/repo"),
    /No index exists/,
  );
  await assert.rejects(
    searchZg(async () => { throw new Error("command not found"); }, { query: "theme persistence" }, "/work/repo"),
    /Unable to run zg.*command not found/,
  );
});

test("resolveZgCommand resolves global node module path on win32", () => {
  const winAppData = "C:\\Users\\test\\AppData\\Roaming";
  const expectedCli = `${winAppData}\\npm\\node_modules\\@zvec\\zvec-grep\\dist\\cli\\index.js`;

  const appDataResolved = resolveZgCommand(
    "win32",
    { APPDATA: winAppData },
    "C:\\Program Files\\nodejs\\node.exe",
    (path) => path === expectedCli,
  );
  assert.deepEqual(appDataResolved, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [expectedCli],
  });

  const userProfileResolved = resolveZgCommand(
    "win32",
    { USERPROFILE: "C:\\Users\\test" },
    "C:\\Program Files\\nodejs\\node.exe",
    (path) => path === expectedCli,
  );
  assert.deepEqual(userProfileResolved, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    prefixArgs: [expectedCli],
  });

  const missingResolved = resolveZgCommand(
    "win32",
    { APPDATA: winAppData },
    "C:\\Program Files\\nodejs\\node.exe",
    () => false,
  );
  assert.deepEqual(missingResolved, {
    command: "zg",
    prefixArgs: [],
  });
});

test("resolveZgCommand falls back to zg on non-win32 platforms", () => {
  assert.deepEqual(resolveZgCommand("linux"), { command: "zg", prefixArgs: [] });
  assert.deepEqual(resolveZgCommand("darwin"), { command: "zg", prefixArgs: [] });
});
