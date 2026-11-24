#!/usr/bin/env node
// Usage:
//   node codex-seat.mjs --worktree <dir> --brief <file> --out <dir>
//                       --model <name> --effort <low|medium|high|xhigh>
//                       [--mode write|read] [--web-search on|off]
//                       [--timeout-min <minutes, at most 1440>]
//
// Runs one Codex worker in <worktree> with the brief on stdin, then writes
//   <out>/report.md     Codex's final message
//   <out>/events.jsonl  the events Codex printed, one JSON object per line
//   <out>/stderr.log    anything Codex printed to stderr
//   <out>/codex.pid     the process group to kill if this script dies first:
//                       kill -- -$(cat <out>/codex.pid)
//   <out>/result.json   whether the run completed and what it left behind
// --mode write (default) lets Codex's commands edit files in the checkout and
// in temp folders. --mode read makes every write by a command fail, for a
// judge or a reviewer. <out> must be new or empty. <out> and the brief must
// sit outside the checkout. Exits 0 only when Codex completed its turn and
// left a report, 124 on timeout, 2 on a usage error.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const KNOWN_FLAGS = ["worktree", "brief", "out", "model", "effort", "mode", "web-search", "timeout-min"];
const SANDBOX_BY_MODE = { write: "workspace-write", read: "read-only" };
const EFFORTS = ["low", "medium", "high", "xhigh"];
// Codex gives a worker these from the signed-in account, and they act outside
// the sandbox: connected apps such as GitHub and Notion, plugins, a browser,
// the desktop, image generation.
const FEATURES_OUTSIDE_THE_SANDBOX = ["apps", "plugins", "browser_use", "browser_use_external", "computer_use", "image_generation"];
const MAX_TIMEOUT_MINUTES = 24 * 60;
const TIMEOUT_EXIT_CODE = 124;
const KILL_GRACE_MS = 10_000;
const STDERR_TAIL_CHARS = 500;
// spawnSync's default of 1 MB is less than `git status` prints for a few thousand untracked files.
const GIT_OUTPUT_LIMIT_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

function fail(message) {
  console.error(`codex-seat: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: "write", "web-search": "on", "timeout-min": "30" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) fail(`expected --flag value pairs, got "${flag}"`);
    if (!KNOWN_FLAGS.includes(flag.slice(2))) fail(`unknown flag ${flag}; the flags are ${KNOWN_FLAGS.map((name) => `--${name}`).join(", ")}`);
    options[flag.slice(2)] = value;
  }
  for (const required of ["worktree", "brief", "out", "model", "effort"]) {
    if (!options[required]) fail(`missing --${required}`);
  }
  if (!SANDBOX_BY_MODE[options.mode]) fail(`--mode must be write or read, got "${options.mode}"`);
  if (!["on", "off"].includes(options["web-search"])) fail(`--web-search must be on or off, got "${options["web-search"]}"`);
  if (!EFFORTS.includes(options.effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}, got "${options.effort}"`);
  const timeoutMinutes = Number(options["timeout-min"]);
  if (!(timeoutMinutes > 0 && timeoutMinutes <= MAX_TIMEOUT_MINUTES)) {
    fail(`--timeout-min must be above 0 and at most ${MAX_TIMEOUT_MINUTES}, got "${options["timeout-min"]}"`);
  }
  return {
    worktree: resolve(options.worktree),
    brief: resolve(options.brief),
    out: resolve(options.out),
    mode: options.mode,
    webSearch: options["web-search"],
    model: options.model,
    effort: options.effort,
    timeoutMinutes,
  };
}

function realPathOf(path) {
  let existing = path;
  const notYetCreated = [];
  while (!existsSync(existing)) {
    notYetCreated.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...notYetCreated);
}

function isInside(parent, child) {
  const path = relative(realPathOf(parent), realPathOf(child));
  const climbsOut = path === ".." || path.startsWith(`..${sep}`);
  return !climbsOut && !isAbsolute(path);
}

function git(dir, args) {
  const run = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT_BYTES });
  return run.status === 0 ? run.stdout : null;
}

// Read in chunks: Node refuses to read a file of 2 GiB or more in one call.
function contentHash(path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return "absent";
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return "unreadable";
  }
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// git runs here on the host, outside the seat's sandbox, and `git status`
// starts the fsmonitor and filter programs that git config names. Such a
// program can be a script inside the checkout, which a seat can edit, so
// status runs with all of them switched off.
function configuredProgramsOff(checkout) {
  const configured = git(checkout, ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]) ?? "";
  const keys = configured.split("\0").filter(Boolean).map((entry) => entry.split("\n")[0]);
  const filtersOff = keys.flatMap((key) => ["-c", key.endsWith(".required") ? `${key}=false` : `${key}=`]);
  return ["-c", "core.fsmonitor=false", ...filtersOff];
}

function uncommittedFiles(checkout) {
  const status = git(checkout, [...configuredProgramsOff(checkout), "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) throw new Error(`git status failed in ${checkout}`);

  const stateOf = new Map();
  const entries = status.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const state = entries[i].slice(0, 2);
    stateOf.set(entries[i].slice(3), state);
    // With -z, git follows a renamed or copied entry with the path it came from.
    if (state[0] === "R" || state[0] === "C") i++;
  }

  return new Map([...stateOf].map(([path, state]) => [path, `${state} ${contentHash(join(checkout, path))}`]));
}

function pathsThatDiffer(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

function codexArgs(seat, reportPath) {
  return [
    "exec",
    "--sandbox", SANDBOX_BY_MODE[seat.mode],
    "--cd", seat.worktree,
    "--model", seat.model,
    "--config", `model_reasoning_effort="${seat.effort}"`,
    "--config", "sandbox_workspace_write.network_access=false",
    "--config", "agents.enabled=false",
    "--disable", "multi_agent_v2",
    ...(seat.webSearch === "off" ? ["--config", 'web_search="disabled"'] : []),
    "--ignore-user-config",
    "--ignore-rules",
    ...FEATURES_OUTSIDE_THE_SANDBOX.flatMap((feature) => ["--disable", feature]),
    "--json",
    "--color", "never",
    "--output-last-message", reportPath,
    "-",
  ];
}

function runCodex(seat, paths) {
  const briefFd = openSync(seat.brief, "r");
  // "wx" fails when the file exists, so two runs given the same --out cannot both start.
  const eventsFd = openSync(paths.events, "wx");
  const stderrFd = openSync(paths.stderr, "wx");

  return new Promise((done) => {
    // detached gives Codex its own process group, so one signal reaches Codex
    // and its helper processes and nothing else.
    const child = spawn("codex", codexArgs(seat, paths.report), {
      stdio: [briefFd, eventsFd, stderrFd],
      detached: true,
    });
    if (child.pid) writeFileSync(paths.pid, `${child.pid}\n`);

    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone, or Codex never started.
      }
    };
    const stop = () => {
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, seat.timeoutMinutes * 60_000);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, stop);

    // Node emits both "error" and "close" when the command cannot start.
    let finished = false;
    const finish = (exitCode, signal, startError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signalGroup("SIGKILL");
      for (const fd of [briefFd, eventsFd, stderrFd]) closeSync(fd);
      done({ exitCode, signal, timedOut, startError });
    };
    child.on("error", (error) => finish(127, null, error.message));
    child.on("close", (code, signal) => finish(timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1), signal, null));
  });
}

function readEvents(eventsPath) {
  const events = [];
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      events.push({ type: "unparsed", text: line });
    }
  }
  return events;
}

// Codex reports warnings and a rerouted model as a completed item of type "error", not as a failed turn.
function isNotice(event) {
  const isErrorItem = event.type === "item.completed" && event.item?.type === "error";
  return isErrorItem || event.type === "error" || event.type === "turn.failed" || event.type === "unparsed";
}

function noticeText(event) {
  return event.item?.message ?? event.message ?? event.error?.message ?? event.text ?? JSON.stringify(event);
}

const seat = parseArgs(process.argv.slice(2));

const checkout = git(seat.worktree, ["rev-parse", "--show-toplevel"])?.trim();
if (!checkout) fail(`not a git worktree: ${seat.worktree}`);
if (!existsSync(seat.brief)) fail(`brief not found: ${seat.brief}`);
if (isInside(checkout, seat.out)) fail(`--out must be outside the checkout at ${checkout}, so the report stays out of the candidate's diff`);
if (isInside(checkout, seat.brief)) fail(`--brief must be outside the checkout at ${checkout}, so it stays out of the candidate's diff`);
if (existsSync(seat.out) && !statSync(seat.out).isDirectory()) fail(`--out is a file, not a folder: ${seat.out}`);
if (existsSync(seat.out) && readdirSync(seat.out).length > 0) {
  fail(`--out must be new or empty, so an earlier run's report cannot pass for this one: ${seat.out}`);
}

let uncommittedBefore;
try {
  uncommittedBefore = uncommittedFiles(checkout);
} catch (error) {
  fail(error.message);
}

mkdirSync(seat.out, { recursive: true });
const paths = {
  report: join(seat.out, "report.md"),
  events: join(seat.out, "events.jsonl"),
  stderr: join(seat.out, "stderr.log"),
  pid: join(seat.out, "codex.pid"),
  result: join(seat.out, "result.json"),
};

const headBefore = git(checkout, ["rev-parse", "HEAD"]);
const startedAt = Date.now();
let run;
try {
  run = await runCodex(seat, paths);
} catch (error) {
  fail(`could not open the output files in ${seat.out}: ${error.message}`);
}
const { exitCode: codexExitCode, signal, timedOut, startError } = run;

const events = readEvents(paths.events);
const completed = events.some((event) => event.type === "turn.completed");
const reportText = existsSync(paths.report) ? readFileSync(paths.report, "utf8").trim() : "";
const hasReport = completed && reportText.length > 0;
const exitCode = codexExitCode === 0 && !hasReport ? 1 : codexExitCode;
const stderrTail = readFileSync(paths.stderr, "utf8").trim().slice(-STDERR_TAIL_CHARS);

const notices = [
  ...(startError ? [`could not start codex: ${startError}`] : []),
  ...events.filter(isNotice).map(noticeText),
  ...(exitCode !== 0 && stderrTail ? [`stderr ended with: ${stderrTail}`] : []),
];
let changedFiles = null;
try {
  changedFiles = pathsThatDiffer(uncommittedBefore, uncommittedFiles(checkout));
} catch (error) {
  notices.push(`could not list changed files: ${error.message}`);
}

const result = {
  seat: "codex",
  mode: seat.mode,
  webSearch: seat.webSearch,
  requested: { model: seat.model, effort: seat.effort },
  completed,
  exitCode,
  signal,
  timedOut,
  notices,
  durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  usage: events.find((event) => event.type === "turn.completed")?.usage ?? null,
  threadId: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
  worktree: seat.worktree,
  checkout,
  headMoved: git(checkout, ["rev-parse", "HEAD"]) !== headBefore,
  uncommittedBefore: [...uncommittedBefore.keys()].sort(),
  changedFiles,
  report: hasReport ? paths.report : null,
  events: paths.events,
  stderr: paths.stderr,
};
writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`);

const changedCount = changedFiles === null ? "an unknown number of" : changedFiles.length;
console.log(
  `codex-seat: exit ${exitCode}${timedOut ? " (timed out)" : ""}, ${completed ? "completed" : "did not complete"}, ${changedCount} changed file(s), ${result.durationSeconds}s. Read ${paths.result}`,
);
process.exit(exitCode);
