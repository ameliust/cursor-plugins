---
name: seat
description: "Run a worker on another vendor's model through that vendor's own CLI, for a harness whose subagent tool takes only one vendor's models. Use for /seat, or when a role value names a seat, such as `codex gpt-6.2-astra high`."
disable-model-invocation: true
---

# Seat

A seat is a worker that runs in another vendor's harness. It gives a panel a second vendor's judgment. A judge or reviewer from the author's own vendor tends to share the author's blind spots, so a mixed panel is worth the extra step.

A role value names a seat as `<seat> <model> <effort>`, such as `codex gpt-6.2-astra high`. The seat name is the vendor for every vendor check, such as the arena cross-judge rule.

| Seat | Script | Needs |
| --- | --- | --- |
| `codex` | `scripts/codex-seat.mjs` | `codex` on PATH and signed in. |

A seat value whose seat is not in this table has no script yet. Drop that seat, keep the rest of the panel, and say so.

## Run a seat

1. Give the seat its own git worktree, as the **arena** skill does for any candidate. A judge or reviewer that only reads can share the base checkout. Install what the task needs to run before you start, because the seat's commands have no network.
2. Write the brief to a file outside the worktree. Open it as the **poteto-mode** skill opens any kickoff, with the `worker.md` line. Then say who you are and who you work for, because the seat sees none of this session. State the goal, the task, what to produce, and where to put it. Ask it to list any step it could not do.
3. Start the script in the background with your shell tool, one call per seat, so that you are told when it ends:

   ```bash
   node <this folder>/scripts/codex-seat.mjs --worktree <dir> --brief <file> --out <new dir> \
     --model <model> --effort <effort> [--mode write|read] [--timeout-min <minutes>]
   ```

   Use `--mode write` for a candidate, and for a reviewer that must run tests or a build. Use `--mode read` for a judge or a reviewer that only reads. `--out` must be a new or empty folder outside the worktree, one per run. The timeout defaults to 30 minutes.
4. When it ends, read `<out>/result.json` first, then `<out>/report.md`.

## Read the result

| Field | Meaning |
| --- | --- |
| `completed` | The seat finished its turn. When it is false, treat the seat as a dropout, proceed with the others, and say so. A completed turn can still say "I could not do this", so read the report. |
| `exitCode` | 0 only when the seat completed and left a report. 124 means the timeout stopped it. |
| `notices` | What the seat's CLI reported: warnings, a rerouted model, a refused model, an account out of usage. A healthy run can have entries. |
| `report` | The path of the seat's final message, or null when there is none to trust. |
| `usage` | The tokens the run spent. |
| `threadId` | The seat's session, for finding its transcript under the vendor's home folder. |

You own the seat's work, as you own any subagent's. Read what it changed with `git -C <worktree> status` and `git -C <worktree> diff`, and write your own summary.

## What to expect from a codex seat

Seen with codex-cli 0.169.0 on Linux. These describe how it behaved, so a lead knows what to plan for. They are not guarantees.

- It runs with the user's own Codex setup: their config, the repository's `AGENTS.md`, and the repository's `.codex/` config and hooks when the user trusted that repository. It does not read `CLAUDE.md`.
- The script turns off the connected apps and plugins of the signed-in account, such as GitHub and Notion, because those act as the account's owner outside the worktree. Everything else is as Codex ships it, web search included.
- In `write` mode its commands could edit the worktree and temp folders, and nothing else. `git add` and `git commit` failed in a linked worktree, so the lead commits.
- In `read` mode its commands could not write at all, temp folders included, so a test suite that writes a cache fails there.
- Its commands had no network in either mode.
- It never asks a person a question. A command the sandbox refuses fails and the run goes on.
