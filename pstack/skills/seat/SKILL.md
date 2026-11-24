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
| `codex` | `scripts/codex-seat.mjs` | `codex` on PATH, signed in, and allowed to run the model. Check with `codex exec --model <model> --config model_reasoning_effort="<effort>" --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules "Reply with exactly: OK" < /dev/null`, which exits 0 when all three hold. Keep the `< /dev/null`: with an open stdin Codex waits for more prompt and never returns. |

A seat value whose seat is not in this table has no script yet. Drop that seat, keep the rest of the panel, and say so.

## Run a seat

1. Give the seat its own git worktree, as the **arena** skill does for any candidate. A judge or reviewer that runs nothing can share the base checkout. Install what the task needs to run before you start, because the seat's commands have no network. Keep the repository, the brief, and the output folder out of `/tmp` and `$TMPDIR`, because a seat can write there.
2. Write the brief to a file outside the worktree. Open it as the **poteto-mode** skill opens any kickoff, with the `worker.md` line. Then say who you are and who you work for, because the seat sees none of this session. State the goal, the task, what to produce, and where to put it. Ask it not to commit, and ask it to list any step it could not do.
3. Start the script in the background with your shell tool, one call per seat, so that you are told when it ends:

   ```bash
   node <this folder>/scripts/codex-seat.mjs --worktree <dir> --brief <file> --out <new dir> \
     --model <model> --effort <effort> [--mode write|read] [--web-search on|off] [--timeout-min <minutes>]
   ```

   Use `--mode write` for a candidate, and for a reviewer that must run tests or a build, in a worktree you can throw away. Use `--mode read` for a judge or a reviewer that only reads. `--out` must be a new or empty folder outside the checkout, one per run. The timeout defaults to 30 minutes. Web search is on. Pass `--web-search off` when the seat can read something that must not leave the machine, because a seat can read every file the user can read and a search is a way out.
4. When it ends, read `<out>/result.json` first, then `<out>/report.md`. If the script itself was killed and left no `result.json`, the seat may still be running. Stop it with `kill -- -$(cat <out>/codex.pid)`.

## Read the result

| Field | Meaning |
| --- | --- |
| `completed` | The seat finished its turn. When it is false, treat the seat as a dropout, proceed with the others, and say so. A completed turn can still say "I could not do this", so read the report. |
| `exitCode` | 0 only when the seat completed and left a report. 124 means the timeout stopped it. |
| `notices` | What the seat's CLI reported: warnings, a rerouted model, a refused model, an account out of usage. A healthy run can have entries. Accept a seat's result only when `exitCode` is 0, `completed` is true, and `report` points to a file that is not empty. |
| `report` | The path of the seat's final message, or null when there is none to trust. |
| `changedFiles` | Every uncommitted path git reports whose status or content changed during the run, whoever changed it. Ignored files, such as build output or `.env`, are not listed. Null when git could not list them. |
| `uncommittedBefore` | Paths that were already uncommitted when the run started. |
| `headMoved` | HEAD moved during the run. In a worktree only the seat used, the seat committed although you asked it not to, so read the commits before you trust the candidate. In a shared checkout it may have been you or another agent. |
| `usage` | The tokens the run spent. |
| `threadId` | The seat's session, for finding its transcript under the vendor's home folder. |

You own the seat's work, as you own any subagent's. Read `git -C <worktree> diff` and `git -C <worktree> diff --cached`, open the new files that `changedFiles` lists, because a diff leaves out untracked files, and write your own summary.

## What a codex seat can do

Each line was measured with codex-cli 0.169.0 on Linux, using the sandbox helper that ships with Codex. Measure again on a new machine or after an upgrade before you rely on a limit: ask a seat to write one file under your home folder, outside its worktree and outside `/tmp` and `$TMPDIR`, and check that the file is absent.

- In `write` mode its commands edit files in the worktree, in `/tmp`, and in `$TMPDIR`. Writes anywhere else fail.
- In `write` mode `git add` and `git commit` fail in a linked worktree, because Codex keeps the repository's `.git` folder read-only.
- In `read` mode every write by a command fails, temp folders included, so a test suite that writes a cache fails too. It can read any file the user can read, including other candidates' worktrees.
- Its commands have no network in either mode. The model has web search unless you pass `--web-search off`.
- The script turns off the connected apps, plugins, browser, desktop control, and image generation that Codex otherwise gives a worker from the signed-in account. Those act outside the sandbox. A connected GitHub or Notion account is among them.
- The script turns off its tools for starting other Codex agents.
- It reads the `AGENTS.md` files from the repository root down to the worktree, and an `AGENTS.md` in the Codex home folder. It does not read `CLAUDE.md`. The script makes it ignore the user's Codex `config.toml` and rule files, so the model and effort you pass are the ones requested, no MCP server from that file starts, and no allow rule lets a command out of the sandbox. A repository's own `.codex/` config and hooks do not load in a seat either, even when the user trusted that repository, because the trust is saved in the user's `config.toml`.
- Codex can reroute a run to another model. When it does, `notices` in the result says so.
- It never asks a person a question. A command the sandbox refuses fails and the run goes on.
- Git config can name programs that git starts by itself, such as a filter or an fsmonitor hook. The script's own git calls switch them off. Codex does not: when it starts in a repository it runs git outside the sandbox, and a configured filter ran. If such a program is a script inside the checkout, a write-mode seat can edit it, so run `git config --get-regexp '^(filter\.|core\.fsmonitor)'` in a repository before you seat a worker there.
- A machine-wide Codex config, such as `/etc/codex/config.toml`, still applies, MCP servers included. The script cannot turn that layer off, so read it on a machine that has one.
- Each run leaves a session record that holds the brief in the Codex home folder.
- Each running seat held about 0.25 GB of memory, which bounds how many run at once on a small machine.
