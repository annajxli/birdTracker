# Guide for agents and contributors

This file is for anyone who changes this repository, including AI coding
agents such as Codex and Claude Code. Read it before you start a task. For what
the project is, see the [README](README.md).

## Work alongside other agents

Several agents work in this repository at the same time, each in its own
branch, and sometimes in the same checkout. To avoid overwriting each other's
work, follow these rules:

- Work on your own branch, created from an up-to-date `main`. Name it
  `AGENT/TOPIC`, where `AGENT` is your agent's name and `TOPIC` describes the
  change, such as `codex/ui-live-polish`.
- Use a separate Git worktree or clone for your branch. Don't switch the
  branch of a checkout that you didn't create.
- Before you start, run `git fetch` and `git status`, and read the
  [Status](docs/status.md) page, which lists work on other branches.
- Leave uncommitted changes that you didn't make as they are. Don't stash,
  reset, clean, or reformat them.
- Don't run `git worktree prune`. Worktrees can live on another computer or in
  a sandbox with different paths, so they can look missing when they aren't.
- Deploy to the indoor computer only from a session on the home network, and
  record the deployment on the [Status](docs/status.md) page.

## Commits and merges

- Keep each change in a few logical commits, usually one commit per update.
  Write a title that describes the resulting behavior.
- Keep unrelated work in separate commits and branches.
- Squash-merge pull requests, so that `main` has one commit per update. You
  don't need to rewrite a branch that others already use.
- Never commit secrets. `publish.env`, `firmware/**/secrets.h`, and
  `birdtracker.env` hold credentials, and Git ignores the first two.

## Checks

Before you commit, run the checks that apply to your change:

- Dashboard components: `node --test dashboard/test/*.test.mjs`
- Password Worker: `node deploy/password-worker.test.mjs`
- Site build: `npm --prefix dashboard run build`
- Whitespace: `git diff --check`

For setup, see [Development](docs/development.md).

## Documentation

### Where documentation goes

The following table lists where each kind of documentation goes:

| File | Contents |
| --- | --- |
| `README.md` | What the project is, a quickstart, and the documentation map |
| `AGENTS.md` | Rules for changing the repository |
| `docs/architecture.md` | How the system works on `main`, and design decisions |
| `docs/development.md` | Running and testing on a development computer |
| `docs/deploy.md` | Deploying the website, R2, and the indoor computer |
| `docs/hardware.md` | The outdoor recorder |
| `docs/status.md` | What is deployed, in progress, or unverified |
| `docs/plans/TOPIC.md` | A proposal that isn't implemented on `main` |
| `docs/bench-test-NUMBER.md` | A dated record of a test, where `NUMBER` is the test's number |
| `docs/design/` | Design artifacts, such as hardware comparisons |

Module docstrings and `--help` output are the reference for each script's
behavior and flags.

### Keep documentation in sync

- **State each fact in one place.** Link to it from other pages instead of
  copying it.
- **Point to the code for values.** Don't copy default values, intervals, or
  thresholds from the code into the documentation. Name the flag or constant,
  and its file, instead. For example, write "`--snapshot-hours` in
  `pipeline/publish.py`", not "every 3 hours".
- **Record status only in `docs/status.md`.** Other pages describe how things
  work, without words such as *currently*, *not yet*, *for now*, or *planned*.
- **Keep plans separate.** Describe unimplemented work in `docs/plans/`, with
  its state in the first paragraph. When the work merges, move the behavior
  into `architecture.md` or `deploy.md`, and delete what the plan no longer
  needs.
- **Don't change records.** Test records keep the results and conditions of
  their date. To correct one, add a dated note.
- **Update documentation with the code.** If a change affects documented
  behavior, update the documentation in the same commit.
- **Check references when you move a page.** Code comments refer to some
  documentation paths, such as `docs/deploy.md`. Search the repository for the
  old path, and update every reference.

### Style

Write documentation in the
[Google developer documentation style](https://developers.google.com/style),
with one exception: don't use em dashes. In particular:

- Address the reader as *you*, in active voice and present tense.
- Put a condition or goal before the instruction. For example, write "To
  update the Pi, run `push.sh`", not "Run `push.sh` to update the Pi".
- Use sentence case for headings.
- Put filenames, paths, commands, flags, environment variables, and code
  identifiers in code font.
- Use descriptive link text, never "here".
- Write *Wi-Fi* in prose. Keep `wifi` only where it's literal text from code or a log.
- Write dates as *October 26, 2026*, or as `2026-10-26` in data.
- Use `UPPER_SNAKE_CASE` placeholders in commands, and explain each one.
