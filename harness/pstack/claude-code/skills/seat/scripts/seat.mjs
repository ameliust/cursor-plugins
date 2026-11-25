#!/usr/bin/env node
// Usage:
//   node seat.mjs --seat <codex|gemini> --worktree <dir> --brief <file> --out <dir>
//                 --model <name> --effort <low|medium|high|xhigh>
//                 [--mode write|read] [--timeout-min <minutes>]
//
// Runs one worker on another vendor's CLI in <worktree>, then writes
//   <out>/report.md    the worker's final message
//   <out>/stdout.log   what the CLI printed (JSON events for codex, one JSON object for gemini)
//   <out>/stderr.log   anything the CLI printed to stderr
//   <out>/result.json  whether the run completed
// --mode write (default) lets the worker edit files in the worktree.
// --mode read is for a judge or a reviewer that only reads.
// <out> must be new or empty, and outside <worktree>.
// Exits 0 only when the worker completed its turn and left a report, 124 on
// timeout, 2 on a usage error.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const FLAGS = ["seat", "worktree", "brief", "out", "model", "effort", "mode", "timeout-min"];
const EFFORTS = ["low", "medium", "high", "xhigh"];
const TIMEOUT_EXIT_CODE = 124;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const SEATS = {
  codex: {
    command: "codex",
    briefOnStdin: true,
    args: (seat, paths) => [
      "exec",
      "--sandbox", seat.mode === "read" ? "read-only" : "workspace-write",
      "--cd", seat.worktree,
      "--model", seat.model,
      "--config", `model_reasoning_effort="${seat.effort}"`,
      // Codex hands a worker the signed-in account's connected apps, such as
      // GitHub and Notion. They act as the account's owner, outside the sandbox.
      "--disable", "apps",
      "--disable", "plugins",
      "--json",
      "--output-last-message", paths.report,
      "-",
    ],
    outcome: (stdout, paths) => {
      const events = stdout.split("\n").filter(Boolean).map((line) => parseJson(line) ?? { type: "error", message: line });
      // Codex reports warnings and a rerouted model as a completed item of type "error".
      const isNotice = (event) => event.item?.type === "error" || ["error", "turn.failed"].includes(event.type);
      return {
        completed: events.some((event) => event.type === "turn.completed"),
        report: existsSync(paths.report) ? readFileSync(paths.report, "utf8") : "",
        notices: events.filter(isNotice).map((event) => event.item?.message ?? event.message ?? event.error?.message ?? JSON.stringify(event)),
        usage: events.find((event) => event.type === "turn.completed")?.usage ?? null,
        threadId: events.find((event) => event.type === "thread.started")?.thread_id ?? null,
      };
    },
  },
  gemini: {
    command: "agy",
    briefOnStdin: false,
    args: (seat) => [
      // agy takes the prompt as the value of --print, and has no flag for the working folder.
      `--print=${readFileSync(seat.brief, "utf8")}`,
      "--model", seat.model,
      "--effort", seat.effort,
      "--sandbox",
      ...(seat.mode === "read" ? ["--mode", "plan"] : []),
      "--output-format", "json",
      "--print-timeout", `${Math.round(Number(seat["timeout-min"]) * 60)}s`,
    ],
    outcome: (stdout) => {
      const output = parseJson(stdout) ?? {};
      return {
        completed: output.status === "SUCCESS",
        report: output.response ?? "",
        notices: output.status && output.status !== "SUCCESS" ? [`agy ended with status ${output.status}`] : [],
        usage: output.usage ?? null,
        threadId: output.conversation_id ?? null,
      };
    },
  },
};

function fail(message) {
  console.error(`seat: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { mode: "write", "timeout-min": "30" };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    if (!FLAGS.includes(name) || argv[i + 1] === undefined) fail(`expected ${FLAGS.map((flag) => `--${flag} <value>`).join(" ")}`);
    options[name] = argv[i + 1];
  }
  for (const required of ["seat", "worktree", "brief", "out", "model", "effort"]) {
    if (!options[required]) fail(`missing --${required}`);
  }
  if (!SEATS[options.seat]) fail(`--seat must be one of ${Object.keys(SEATS).join(", ")}, got "${options.seat}"`);
  if (!["write", "read"].includes(options.mode)) fail(`--mode must be write or read, got "${options.mode}"`);
  if (!EFFORTS.includes(options.effort)) fail(`--effort must be one of ${EFFORTS.join(", ")}, got "${options.effort}"`);
  if (!(Number(options["timeout-min"]) > 0)) fail(`--timeout-min must be a number above 0, got "${options["timeout-min"]}"`);
  return { ...options, worktree: resolve(options.worktree), brief: resolve(options.brief), out: resolve(options.out) };
}

function runWorker(vendor, seat, paths) {
  const stdio = [vendor.briefOnStdin ? openSync(seat.brief, "r") : "ignore", openSync(paths.stdout, "w"), openSync(paths.stderr, "w")];
  const child = spawn(vendor.command, vendor.args(seat, paths), { cwd: seat.worktree, stdio });
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
      for (const fd of stdio) if (typeof fd === "number") closeSync(fd);
      done({ exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1), timedOut, startError });
    });
  });
}

const seat = parseArgs(process.argv.slice(2));
const vendor = SEATS[seat.seat];
if (!existsSync(seat.brief)) fail(`brief not found: ${seat.brief}`);
const outFromWorktree = relative(seat.worktree, seat.out);
if (outFromWorktree !== ".." && !outFromWorktree.startsWith(`..${sep}`)) fail("--out must be outside the worktree, so the report stays out of the candidate's diff");
if (existsSync(seat.out) && readdirSync(seat.out).length > 0) fail(`--out must be new or empty, so an earlier run's report cannot pass for this one: ${seat.out}`);

mkdirSync(seat.out, { recursive: true });
const paths = {
  report: join(seat.out, "report.md"),
  stdout: join(seat.out, "stdout.log"),
  stderr: join(seat.out, "stderr.log"),
  result: join(seat.out, "result.json"),
};

const startedAt = Date.now();
const { exitCode: cliExitCode, timedOut, startError } = await runWorker(vendor, seat, paths);
const outcome = vendor.outcome(readFileSync(paths.stdout, "utf8"), paths);
const hasReport = outcome.completed && outcome.report.trim().length > 0;
if (hasReport) writeFileSync(paths.report, outcome.report);
const exitCode = cliExitCode === 0 && !hasReport ? 1 : cliExitCode;
const stderrTail = readFileSync(paths.stderr, "utf8").trim().slice(-500);

const result = {
  seat: seat.seat,
  mode: seat.mode,
  requested: { model: seat.model, effort: seat.effort },
  completed: outcome.completed,
  exitCode,
  timedOut,
  notices: [
    ...(startError ? [`could not start ${vendor.command}: ${startError}`] : []),
    ...outcome.notices,
    ...(stderrTail ? [stderrTail] : []),
  ],
  durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  usage: outcome.usage,
  threadId: outcome.threadId,
  report: hasReport ? paths.report : null,
};
writeFileSync(paths.result, `${JSON.stringify(result, null, 2)}\n`);
console.log(`seat ${seat.seat}: exit ${exitCode}${timedOut ? " (timed out)" : ""}, ${hasReport ? "completed with a report" : "no report"}, ${result.durationSeconds}s. Read ${paths.result}`);
process.exit(exitCode);
