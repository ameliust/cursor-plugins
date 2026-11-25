#!/usr/bin/env node
// Usage:
//   node codex-seat.mjs --worktree <dir> --brief <file> --out <dir>
//                       --model <name> --effort <low|medium|high|xhigh>
//                       [--mode write|read] [--timeout-min <minutes>]
//
// Runs one Codex worker in <worktree> with the brief on stdin, then writes
//   <out>/report.md     Codex's final message
//   <out>/events.jsonl  the events Codex printed, one JSON object per line
//   <out>/stderr.log    anything Codex printed to stderr
//   <out>/result.json   whether the run completed
// --mode write (default) lets Codex edit files in the worktree.
// --mode read is for a judge or a reviewer that only reads.
// <out> must be new or empty, and outside <worktree>.
// Exits 0 only when Codex completed its turn and left a report, 124 on
// timeout, 2 on a usage error.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const FLAGS = ["worktree", "brief", "out", "model", "effort", "mode", "timeout-min"];
const SANDBOX_BY_MODE = { write: "workspace-write", read: "read-only" };
const EFFORTS = ["low", "medium", "high", "xhigh"];
// Codex hands a worker the signed-in account's connected apps, such as GitHub
// and Notion. They act as the account's owner, outside the sandbox.
const ACCOUNT_FEATURES = ["apps", "plugins"];
const TIMEOUT_EXIT_CODE = 124;

function fail(message) {
  console.error(`codex-seat: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: "write", "timeout-min": "30" };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    if (!FLAGS.includes(name) || argv[i + 1] === undefined) fail(`expected ${FLAGS.map((flag) => `--${flag} <value>`).join(" ")}`);
    options[name] = argv[i + 1];
  }
  for (const required of ["worktree", "brief", "out", "model", "effort"]) {
    if (!options[required]) fail(`missing --${required}`);
  }
  if (!SANDBOX_BY_MODE[options.mode]) fail(`--mode must be write or read, got "${options.mode}"`);
  if (!EFFORTS.includes(options.effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}, got "${options.effort}"`);
  if (!(Number(options["timeout-min"]) > 0)) fail(`--timeout-min must be a number above 0, got "${options["timeout-min"]}"`);
  return { ...options, worktree: resolve(options.worktree), brief: resolve(options.brief), out: resolve(options.out) };
}

function runCodex(seat, paths) {
  const stdio = [openSync(seat.brief, "r"), openSync(paths.events, "w"), openSync(paths.stderr, "w")];
  const child = spawn(
    "codex",
    [
      "exec",
      "--sandbox", SANDBOX_BY_MODE[seat.mode],
      "--cd", seat.worktree,
      "--model", seat.model,
      "--config", `model_reasoning_effort="${seat.effort}"`,
      ...ACCOUNT_FEATURES.flatMap((feature) => ["--disable", feature]),
      "--json",
      "--output-last-message", paths.report,
      "-",
    ],
    { stdio },
  );
  return new Promise((done) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Number(seat["timeout-min"]) * 60_000);
    // Node emits both "error" and "close" when the command cannot start.
    let startError = null;
    child.on("error", (error) => {
      startError = error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      stdio.forEach((fd) => closeSync(fd));
      done({ exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1), timedOut, startError });
    });
  });
}

const seat = parseArgs(process.argv.slice(2));
if (!existsSync(seat.brief)) fail(`brief not found: ${seat.brief}`);
const outFromWorktree = relative(seat.worktree, seat.out);
if (outFromWorktree !== ".." && !outFromWorktree.startsWith(`..${sep}`)) fail("--out must be outside the worktree, so the report stays out of the candidate's diff");
if (existsSync(seat.out) && readdirSync(seat.out).length > 0) fail(`--out must be new or empty, so an earlier run's report cannot pass for this one: ${seat.out}`);

mkdirSync(seat.out, { recursive: true });
const paths = {
  report: join(seat.out, "report.md"),
  events: join(seat.out, "events.jsonl"),
  stderr: join(seat.out, "stderr.log"),
  result: join(seat.out, "result.json"),
};

const startedAt = Date.now();
const { exitCode: codexExitCode, timedOut, startError } = await runCodex(seat, paths);

const events = readFileSync(paths.events, "utf8").split("\n").filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "unparsed", message: line };
  }
});
const completed = events.some((event) => event.type === "turn.completed");
const hasReport = completed && existsSync(paths.report) && readFileSync(paths.report, "utf8").trim().length > 0;
const exitCode = codexExitCode === 0 && !hasReport ? 1 : codexExitCode;
// Codex reports warnings and a rerouted model as a completed item of type "error".
const isNotice = (event) => event.item?.type === "error" || ["error", "turn.failed", "unparsed"].includes(event.type);

const result = {
  seat: "codex",
  mode: seat.mode,
  requested: { model: seat.model, effort: seat.effort },
  completed,
  exitCode,
  timedOut,
  notices: [
    ...(startError ? [`could not start codex: ${startError}`] : []),
    ...events.filter(isNotice).map((event) => event.item?.message ?? event.message ?? event.error?.message ?? JSON.stringify(event)),
    ...(exitCode !== 0 ? [readFileSync(paths.stderr, "utf8").trim().slice(-500)].filter(Boolean) : []),
  ],
  durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  usage: events.find((event) => event.type === "turn.completed")?.usage ?? null,
  threadId: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
  report: hasReport ? paths.report : null,
};
writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`);
console.log(`codex-seat: exit ${exitCode}${timedOut ? " (timed out)" : ""}, ${completed ? "completed" : "did not complete"}, ${result.durationSeconds}s. Read ${paths.result}`);
process.exit(exitCode);
