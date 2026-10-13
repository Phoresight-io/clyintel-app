# D3 Factory

The D3 Factory is the automated design → build → test → review pipeline that turns a
Slack brief into a draft pull request. This page describes how it flows, where each piece
runs, what shows up in Slack, the setup that must stay true, what belongs in the factory,
and what is still planned.

## Flow

`/d3 <brief>` in the factory Slack channel → slack-dispatch (Vercel, deploys from main
only) → `repository_dispatch` → `.github/workflows/d3-factory.yml`:

`prepare` → `notify-start` → `pipeline` (planner → coder → tester → reviewer in a locked
container: egress to api.anthropic.com only, one secret) → `notify-agents` → `publish`
(draft PR to develop) → `notify-failure` on failure.

## What runs from where

The workflow runs from main (changes need a "Promote develop to main" PR); the
orchestrator, role guard and agent prompts run from develop.

## The Slack thread

The thread carries, in order: a start message, one note per agent that wrote one (an
agent that ran but wrote no note is skipped — no placeholder note is posted), then the PR
message.

The requester is tagged on "Needs you" notes, REQUEST CHANGES/BLOCK verdicts, the opened
PR, and failures. Previews are off; agent text is capped and escaped.

## Setup that must stay true

- The Phoresight bot is a member of the factory channel.
- Repo secret `SLACK_BOT_TOKEN` (bot token, `xoxb-`).
- Repo variable `D3_DEFAULT_CHANNEL` for Actions-tab runs.
- Failed posts log `Slack post failed: <code>` (`channel_not_found` = bot not in channel;
  `invalid_auth` = bad token).

## Good factory work

Small, clearly stated app changes under `clyintel/` away from the sensitive paths.
Anything touching guardrails, schema or money paths is done in a supervised Claude session
instead; the factory is barred from those paths by design.

## Planned / open

- Trusted read-only copy of the guard (held).
- `:factory:` reaction to dispatch a brief from Slack.
- Stages B/C (planner asks for decisions; reply in thread to continue).
- Removing WebSearch from the planner.
- Lint not yet in CI.
- `voice_calls` / `set_updated_at` drift (see `schema/MIGRATIONS.md`).
