import { existsSync } from "node:fs";
import { join, resolve, win32 } from "node:path";

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 50;
export const DIRECT_MODE_ARGS = ["--mode", "direct"] as const;
export const SYMBOL_TYPES = ["module", "class", "interface", "function", "value", "alias"] as const;

export type ZgSymbolType = (typeof SYMBOL_TYPES)[number];
export type ZgFreshness = "eventual" | "wait_for_fresh";

export interface ZgSearchInput {
  root?: string;
  query?: string;
  queries?: string[];
  fts?: string[];
  vector?: string[];
  fuse?: boolean;
  limit?: number;
  globs?: string[];
  insensitiveGlobs?: string[];
  fileTypes?: string[];
  excludedFileTypes?: string[];
  symbolTypes?: ZgSymbolType[];
  preferSymbol?: boolean;
  modifiedAfter?: string;
  modifiedBefore?: string;
  freshness?: ZgFreshness;
  autoUpdate?: boolean;
}

export interface ZgRgInput {
  root?: string;
  command: string;
}

export interface ZgStatusInput {
  root?: string;
  checkReady?: boolean;
}

export interface ZgIndexInput {
  root?: string;
  embedding?: string;
  rebuild?: boolean;
  resetPaths?: boolean;
  globs?: string[];
  insensitiveGlobs?: string[];
  fileTypes?: string[];
  excludedFileTypes?: string[];
  hidden?: boolean;
  noIgnore?: boolean;
  ignoreFiles?: string[];
  maxDepth?: number;
  maxFileSize?: string;
  follow?: boolean;
  apiKey?: string;
  endpoint?: string;
  modelCache?: string;
  device?: "auto" | "cpu" | "metal" | "vulkan" | "cuda";
  embeddingConcurrency?: number;
  allowRemote?: boolean;
}

export interface ZgExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ZgExec = (
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout: number },
) => Promise<ZgExecResult>;

export interface ParsedRgCommand {
  args: string[];
  head?: number;
}

export function resolveRoot(root: string | undefined, cwd: string): string {
  return resolve(cwd, root?.replace(/^@/, "") || ".");
}

function nonEmptyGroups(values: string[] | undefined, name: string): string[] {
  if (!values) return [];
  return values.map((value) => {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${name} cannot contain an empty query.`);
    return trimmed;
  });
}

function optionGroups(flag: string, values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => [flag, value]);
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
}

function refreshArgs(freshness: ZgFreshness | undefined, autoUpdate: boolean | undefined): string[] {
  if (freshness !== undefined && freshness !== "eventual" && freshness !== "wait_for_fresh") {
    throw new Error("freshness must be eventual or wait_for_fresh.");
  }
  if (autoUpdate) {
    throw new Error("autoUpdate is unavailable because pi-zvec-grep forces direct CLI mode; use wait_for_fresh instead.");
  }
  if (freshness === "wait_for_fresh") return ["--refresh", "wait"];
  if (freshness === "eventual" && autoUpdate === false) return ["--refresh", "off"];
  return [];
}

export function buildSearchArgs(input: ZgSearchInput): string[] {
  const query = input.query?.trim();
  if (input.query !== undefined && !query) throw new Error("query cannot be empty.");

  const queries = nonEmptyGroups(input.queries, "queries");
  const fts = nonEmptyGroups(input.fts, "fts");
  const vector = nonEmptyGroups(input.vector, "vector");
  if (!query && queries.length === 0 && fts.length === 0 && vector.length === 0) {
    throw new Error("At least one of query, queries, fts, or vector is required.");
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  validateLimit(limit);

  for (const symbolType of input.symbolTypes ?? []) {
    if (!SYMBOL_TYPES.includes(symbolType)) {
      throw new Error(`symbolTypes must contain only: ${SYMBOL_TYPES.join(", ")}.`);
    }
  }

  return [
    "query",
    ...DIRECT_MODE_ARGS,
    ...(query ? [query] : []),
    ...optionGroups("--hybrid", queries),
    ...optionGroups("--fts", fts),
    ...optionGroups("--vector", vector),
    ...(input.fuse ? ["--fuse"] : []),
    "--limit",
    String(limit),
    ...optionGroups("--glob", input.globs),
    ...optionGroups("--iglob", input.insensitiveGlobs),
    ...optionGroups("--type", input.fileTypes),
    ...optionGroups("--type-not", input.excludedFileTypes),
    ...optionGroups("--symbol-type", input.symbolTypes),
    ...(input.preferSymbol ? ["--prefer-symbol"] : []),
    ...(input.modifiedAfter ? ["--modified-after", input.modifiedAfter] : []),
    ...(input.modifiedBefore ? ["--modified-before", input.modifiedBefore] : []),
    ...refreshArgs(input.freshness, input.autoUpdate),
  ];
}

/** Split an rg command without evaluating shell syntax. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaping = false;

  const pushToken = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaping) {
      token += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        const next = command[index + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`" || next === "\n") {
          escaping = true;
        } else {
          token += char;
          tokenStarted = true;
        }
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else if (char === "\\") {
      escaping = true;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      pushToken();
    } else if (char === "|") {
      pushToken();
      tokens.push(char);
    } else {
      token += char;
      tokenStarted = true;
    }
  }

  if (quote) throw new Error("rg command has an unterminated quote.");
  if (escaping) throw new Error("rg command has a trailing escape.");
  pushToken();
  return tokens;
}

export function parseRgCommand(command: string): ParsedRgCommand {
  const tokens = splitCommand(command);
  if (tokens[0] !== "rg") {
    throw new Error("command must begin with rg.");
  }

  const pipeIndex = tokens.indexOf("|");
  if (pipeIndex === -1) {
    if (tokens.length === 1) throw new Error("rg command must include a pattern.");
    return { args: tokens.slice(1) };
  }

  if (tokens.indexOf("|", pipeIndex + 1) !== -1) {
    throw new Error("Only an optional trailing | head -N is supported.");
  }

  const tail = tokens.slice(pipeIndex + 1);
  const compactHead = tail.length === 2 && tail[0] === "head" && /^-\d+$/.test(tail[1]);
  const longHead = tail.length === 3 && tail[0] === "head" && tail[1] === "-n" && /^\d+$/.test(tail[2]);
  if (!compactHead && !longHead) {
    throw new Error("Only an optional trailing | head -N is supported.");
  }

  const head = Number((compactHead ? tail[1].slice(1) : tail[2]));
  if (!Number.isInteger(head) || head < 1) {
    throw new Error("head must request at least one line.");
  }

  const args = tokens.slice(1, pipeIndex);
  if (args.length === 0) throw new Error("rg command must include a pattern.");
  return { args, head };
}

export function buildRgArgs(input: ZgRgInput): string[] {
  return ["query", ...DIRECT_MODE_ARGS, "--rg", ...parseRgCommand(input.command).args];
}

function positiveIntegerArgs(flag: string, value: number | undefined): string[] {
  if (value === undefined) return [];
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer.`);
  return [flag, String(value)];
}

export function buildIndexArgs(input: ZgIndexInput = {}): string[] {
  return [
    "index",
    ...DIRECT_MODE_ARGS,
    ...(input.embedding ? ["--embedding", input.embedding] : []),
    ...(input.rebuild ? ["--rebuild"] : []),
    ...(input.resetPaths ? ["--reset-paths"] : []),
    ...optionGroups("--glob", input.globs),
    ...optionGroups("--iglob", input.insensitiveGlobs),
    ...optionGroups("--type", input.fileTypes),
    ...optionGroups("--type-not", input.excludedFileTypes),
    ...(input.hidden ? ["--hidden"] : []),
    ...(input.noIgnore ? ["--no-ignore"] : []),
    ...optionGroups("--ignore-file", input.ignoreFiles),
    ...positiveIntegerArgs("--max-depth", input.maxDepth),
    ...(input.maxFileSize ? ["--max-filesize", input.maxFileSize] : []),
    ...(input.follow ? ["--follow"] : []),
    ...(input.apiKey ? ["--api-key", input.apiKey] : []),
    ...(input.endpoint ? ["--endpoint", input.endpoint] : []),
    ...(input.modelCache ? ["--model-cache", input.modelCache] : []),
    ...(input.device ? ["--device", input.device] : []),
    ...positiveIntegerArgs("--embedding-concurrency", input.embeddingConcurrency),
    ...(input.allowRemote ? ["--allow-remote"] : []),
  ];
}

export function resolveZgCommand(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  checkExists: (path: string) => boolean = existsSync,
): { command: string; prefixArgs: string[] } {
  if (platform === "win32") {
    const pathJoin = platform === "win32" ? win32.join : join;
    const roots: string[] = [];
    if (env.APPDATA) roots.push(env.APPDATA);
    if (env.USERPROFILE) roots.push(pathJoin(env.USERPROFILE, "AppData", "Roaming"));
    for (const root of roots) {
      const cli = pathJoin(root, "npm", "node_modules", "@zvec", "zvec-grep", "dist", "cli", "index.js");
      if (checkExists(cli)) return { command: execPath, prefixArgs: [cli] };
    }
  }
  return { command: "zg", prefixArgs: [] };
}

async function runZg(
  execute: ZgExec,
  args: string[],
  root: string,
  signal: AbortSignal | undefined,
  allowNoMatches = false,
): Promise<string> {
  let result: ZgExecResult;

  try {
    const zgLaunch = resolveZgCommand();
    result = await execute(zgLaunch.command, [...zgLaunch.prefixArgs, ...args], { cwd: root, signal, timeout: 600_000 });
  } catch (error) {
    throw new Error(
      `Unable to run zg. Install it with \`npm install -g @zvec/zvec-grep\`. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.code !== 0 && !(allowNoMatches && result.code === 1 && !output)) {
    throw new Error(output || `zg ${args[0]} failed with exit code ${result.code}.`);
  }

  return output || "No matches.";
}

function limitLines(output: string, head: number | undefined): string {
  return head === undefined ? output : output.split(/\r?\n/).slice(0, head).join("\n");
}

export async function searchZg(
  execute: ZgExec,
  input: ZgSearchInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; output: string }> {
  const root = resolveRoot(input.root, cwd);
  return { root, output: await runZg(execute, buildSearchArgs(input), root, signal) };
}

export async function rgZg(
  execute: ZgExec,
  input: ZgRgInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; output: string }> {
  const root = resolveRoot(input.root, cwd);
  const parsed = parseRgCommand(input.command);
  const output = await runZg(execute, ["query", ...DIRECT_MODE_ARGS, "--rg", ...parsed.args], root, signal, true);
  return { root, output: limitLines(output, parsed.head) };
}

export async function statusZg(
  execute: ZgExec,
  input: ZgStatusInput | string | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; output: string }> {
  const status = typeof input === "string" ? { root: input } : (input ?? {});
  const root = resolveRoot(status.root, cwd);
  return {
    root,
    output: await runZg(execute, ["status", ...DIRECT_MODE_ARGS, ...(status.checkReady ? ["--check-ready"] : [])], root, signal),
  };
}

export async function indexZg(
  execute: ZgExec,
  input: ZgIndexInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; output: string }> {
  const root = resolveRoot(input.root, cwd);
  return { root, output: await runZg(execute, buildIndexArgs(input), root, signal) };
}

export async function dropIndexZg(
  execute: ZgExec,
  rootInput: string | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; output: string }> {
  const root = resolveRoot(rootInput, cwd);
  return {
    root,
    output: await runZg(execute, ["index", ...DIRECT_MODE_ARGS, "--drop", "--yes"], root, signal),
  };
}
