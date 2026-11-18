# TIER 1 SPEC — Multi-Agent Brainstorm & Planning Rooms

Status: DRAFT for owner approval · Author: COO · 2026-11-18

## Goal (outcome layer)

COO posts ONE kanban card; inside Orca, N agents brainstorm a plan with real
inter-agent messaging and gate checkpoints; merged plan returns headlessly.
No human touches the Orca window unless a gate demands it.

## Key discovery — reuse, don't build

Orca ships an orchestration subsystem (`src/cli/handlers/orchestration/`, 36 files):
runs (objective-scoped), coordinator terminals, workers, tasks, gates, and
agent-to-agent messaging:

    orca orchestration run-create --objective "..."   # scope = one room
    orca orchestration worker-start ...               # spawn agents under a run
    orca orchestration task-create / task-update      # shared task board
    orca orchestration send / check / reply / inbox   # inter-agent messages
    orca orchestration gate-create / gate-resolve     # approval checkpoints
    orca orchestration dispatch / ask                 # one-shot delegation

PROBE (2026-11-18, session 1cb54ffb): bridge-dispatched `hermes-orchestrator`
executed run-list + worker-list --json, exit 0. A bridge agent can drive the
whole subsystem headlessly from its session.

=> Tier 1 is mostly WIRING, not a new product. Repo rule: Reuse Before Reimplement.

## Phase A — Brainstorm via coordinator (ZERO build, available now)

Pattern per card:

1. COO dispatches bridge session `assignee=hermes-orchestrator` with goal template:
   - run-create --objective "<goal>"
   - worker-start x N (e.g. grok = red-team, opencode = feasibility, hermes-research = precedent)
   - task-create one subtask per worker role; workers answer + comment on each other via send/reply
   - round limit: 2 rounds (cost control), then orchestrator writes MERGE section:
     consensus / disagreements (who+what) / recommended plan / open questions
2. COO polls GET /v1/sessions/:id, reads back the merge, gates it (existing /gate route).
3. Accepted plan lands as card result + repo doc.

Cost note: N workers x 2 rounds runs on THEIR engines; gufo untouched except
the thin orchestrator if hermes-* is used as coordinator.

## Phase B — Run proxy endpoints (~1-2 cards, lower token cost)

Today every room turn passes through the coordinator agent (token overhead).
Add thin gateway routes that map 1:1 to existing host services (no new runtime):

- POST /v1/runs {objective} -> run id (wraps orchestration.runCreate)
- POST /v1/runs/:id/workers {agent, brief} (wraps worker-start)
- GET /v1/runs/:id/events?since= (aggregated inbox/task/gate stream)
- POST /v1/runs/:id/gates/:gid {decision} (wraps gate-resolve)
  DONE_CMD: smoke extends with a 2-agent room round-trip incl. one inter-agent message visible in events.

## Phase C — Room view UI (optional, ~2 cards)

Renderer page: left = runs list; center = per-worker transcript columns; bottom =
shared task board + pending gates (approve button). Follows repo AGENTS.md:
all layout/color/typography from docs/STYLEGUIDE.md tokens
(src/renderer/src/assets/main.css CSS variables) and shadcn primitives in
src/renderer/src/components/ui/ — no invented styles. CDP screenshot validation,
no focus stealing (ORCA_BACKGROUND_LAUNCH=1).

## Acceptance criteria (whole tier)

- AC1: one card -> 3-agent brainstorm with >=1 cross-comment, merged plan read back headlessly.
- AC2: gate created inside run is resolvable via bridge /gate route (COO or owner in UI).
- AC3: round limit enforced; total worker turns visible in events/result.

## Risks

- Worker nesting depth: keep coordinator -> workers only (depth 1) until Phase B proves events stream; deeper trees multiply cost and orphan risk.
- Orca restart kills live runs mid-room: bridge readback must surface state=error cleanly (verify in smoke).
- Legacy run namespace (`run_legacy_local`) exists — proxy endpoints should filter legacy:true out of listings.

## Validation findings (2026-11-18)

- Coordinator pattern proven headlessly through: run-create (`run_dcc9d557c475`), spec writes, task fan-out, coordinator handle resolution. Failed at worker #2 start with opaque ACP `Internal error`; lean 1-worker retry was slower than its value.
- ROOT COST ISSUE: the hermes-* coordinator runs on gufo (sessions=1) and competes directly with pi's queue. Multi-agent rooms are therefore NOT the default.
- **Policy (owner-directed): direct single-agent bridge dispatch is the default** — Antigravity completes red-team briefs in minutes with zero coordinator overhead. Rooms only for genuinely divergent perspectives, and then prefer a cloud engine as coordinator or Phase-B routes that skip the coordinator entirely.
- Orphan: `run_dcc9d557c475` left half-started; no stop route exists client-side yet — another argument for Phase B (`POST /v1/runs/:id/stop` to add).

## Sequencing

A now (no code) -> evaluate on 2 real planning cards -> B if token overhead hurts -> C only if COO-side visibility is insufficient (Mission Control cockpit may cover it cheaper).
