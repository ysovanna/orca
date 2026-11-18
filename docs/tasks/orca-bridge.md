# PROJECT BRIEF: Orca Bridge — COO Control Over In-IDE Agents

**STATUS**: APPROVED (owner AAA decisions 2026-11-13)

## Decisions Locked

| Axis      | Choice                                                   | Rationale                                       |
| --------- | -------------------------------------------------------- | ----------------------------------------------- |
| Transport | HTTP gateway inside daemon process                       | Reuses daemon lifecycle, no new service         |
| Auth      | Loopback-only + env-var bearer token (ORCA_BRIDGE_TOKEN) | Simple, no infra dependency for v1              |
| Scope     | Full catalog (any agent with ACP launch spec)            | Adapter pattern scales; zero code per new agent |

## Altitude

COO dispatches/steers/gates tasks to any agent inside Orca as kanban assignees. Orca becomes a first-class execution node.

## Deliverables

| #   | Artifact           | Path                                           |
| --- | ------------------ | ---------------------------------------------- |
| 1   | Architecture doc   | docs/orca-bridge/architecture.md               |
| 2   | HTTP gateway patch | src/main/daemon/endpoint/http-gateway.ts       |
| 3   | ACP adapter module | src/main/acp/bridge/orca-bridge-acp-adapter.ts |
| 4   | Hermes profile     | %LOCALAPPDATA%/hermes/profiles/orca-bridge/    |
| 5   | Smoke harness      | tests/probes/orca-bridge-smoke.ts              |

## Acceptance Criteria

1. orca-bridge-smoke.ts exits 0 against installed Orca binary
2. COO kanban create --assignee orca-bridge produces prompt injection + response readback evidence
3. Bridge rejects unauthenticated requests; no RCE escalation

## Reconfiguration Protocol (post-Orca-update)

Problem: Squirrel auto-update replaces app.asar silently - bridge gone until rebuilt.

Mitigation - Pin + Auto-Rebase Cron:

1. Pin version: disable auto-update at build time (update.channel: none). Owner manually bumps.
2. Weekly cron (COO): fetch upstream tags, rebase orca-bridge branch if newer, pnpm tc + smoke dev build, notify owner install? [y/n].
3. Owner approves y -> silent install (/S). ~40 min total unattended.
4. Rebase conflicts in daemon/: escalate to owner with diff summary.

Update cadence: roughly biweekly. 1 reconfig/month, 40 min + 1 interaction.

## PAUSE STATE (2026-11-16 night)

ACTIVE: OB-0, OB-1, OB-3 running. ON COMPLETION: pause for the night — do NOT release OB-2/4/5/6. OWNER HOLD comments posted on all four successors; they stay blocked until COO releases next session with fresh steer from live HEAD.

## Pipeline — FINAL (2026-11-18)

| Card | Scope | Status | Gate evidence |
|---|---|---|---|
| OB-1..OB-8 | gateway/adapter/pin/build/security/harness/AppEnv/hermes-ACP | done | SMOKE PASS 5/5 on installed binary; catalog hermes+4 profiles available |

Canonical branch: hermes-patch = ob4-integration tip (c17b927150), pushed to ysova-fork.
Token doctrine: HKCU ORCA_BRIDGE_TOKEN live source; C:/HermesOS/Tools/.orca/bridge-token mirrors it (COO syncs after rotation).

## Card Graph (Active Pipeline) — SUPERSEDED by FINAL table above

Live table — maintained by OB-0 (orchestrator). Last sync: 2026-11-16 23:55 +07.

| ID   | Card       | Title                                            | Assignee     | Parents     | Status @sync                                                        |
| ---- | ---------- | ------------------------------------------------ | ------------ | ----------- | ------------------------------------------------------------------- |
| OB-0 | t_03c15813 | Coordination throughout phase                    | orchestrator | -           | running (run 287)                                                   |
| OB-1 | t_0341250c | Architecture doc + daemon HTTP gateway patch     | pi           | -           | **DONE** — verified by OB-0, commit 7415062616 on ob1-http-gateway  |
| OB-2 | t_f62d27e1 | ACP adapter module (card to agent prompt)        | pi           | OB-1 ✓      | blocked — NEEDS MANUAL UNBLOCK (`hermes kanban unblock t_f62d27e1`) |
| OB-3 | t_bc1557a7 | Pin version, disable auto-update, build env prep | home-lab     | -           | **DONE** — verified by OB-0, commit 3f52a0e13d on hermes-patch      |
| OB-4 | t_4f3bc487 | Build patched binary + install + smoke           | home-lab     | OB-2,OB-3 ✓ | blocked → awaiting OB-2 only                                        |
| OB-5 | t_e2f9955d | Security review: bridge auth + RCE surface       | qa-security  | OB-4        | blocked → awaiting OB-4                                             |
| OB-6 | t_5ddddf6a | Hermes profile orca-bridge + smoke harness       | pi           | OB-2        | blocked → awaiting OB-2                                             |

Verified receipts (OB-0 independent evidence, full detail in card comments #248/#249):

- OB-1: commit 7415062616 = exactly architecture.md + http-gateway.ts; gateway read-through conforms to contract v2 (loopback-only listen, ORCA_BRIDGE_PORT default 46133, timing-safe bearer BEFORE routing, inert when token unset, no socket mutation, no token logging). /health body adds `service` field — probes must assert ok==true, not exact body. DONE_CMD defect: `pnpm tc --noEmit` always exits 1 in this repo; correct gate is plain `pnpm tc`.
- OB-3: commit 3f52a0e13d = exactly cjs(+2)/yml(+18); pin v1.4.258=c91a7a6ee3 recorded on-card for OB-4 + rebase cron; shared tree byte-matches.
- OB-2 scope note (from OB-1): daemon-main.ts wiring of startHttpGateway is OB-2's job per architecture.md, not done yet.

Dependency edges (OB-1→OB-2, OB-2/OB-3→OB-4, OB-4→OB-5, OB-2→OB-6) were missing at creation; orchestrator added them 2026-11-16 and DB now reports `unsatisfied_parents` correctly on all four gated cards. Cards sit in `blocked`, so promotion is manual: OB-0 unblocks each successor only when its parents are done. CURRENT RELEASE QUEUE: t_f62d27e1 (OB-2) — OB-0's context cannot call unblock (no tool; CLI guard), owner/default please run it, then OB-4 follows on OB-2 completion.

Incident note (2026-11-16 ~20:24): every live run across the fleet crashed with "Kanban owner refused: Kanban execution unknown; retained by owner" (owner-daemon admission failure, not worker code). Owner set FULL ACCESS; `default` re-dispatched OB-0/OB-1/OB-3 at 21:24–21:40. All prior steering comments remain in force on each card.

⚠ Untracked-writer watch (OB-2 scope): `src/main/acp/bridge/orca-bridge-acp-adapter.ts` (mtime 20:51) and `orca-bridge-card-plan.ts` (20:33) appeared/changed during the 20:24–21:25 no-run window. Unknown writer (owner-side agent or orphaned child of crashed run 272). OB-2's worker must verify against architecture.md + pinned contracts and produce its own DONE_CMD evidence — do not adopt these files as done work.

## Pinned Contracts (orchestrator decisions — all cards build against these)

Last sync: 2026-11-16 18:05 +07 (v2 — port ruling; see plans/orca-bridge/contexts/pinned_contracts_v2.md).

- **Endpoint**: bind `127.0.0.1` only; port from `ORCA_BRIDGE_PORT` env, default **46133** (architecture.md is canonical; earlier 9876 pin retired via comments #230–#234). `GET /health` → 200 `{"ok":true}` iff `Authorization: Bearer $ORCA_BRIDGE_TOKEN`; else 401. Token never logged (OB-5 greps for it). Never hardcode the port.
- **Daemon coexistence**: gateway must not mutate the canonical Unix-socket endpoint entry (src/main/daemon/AGENTS.md ownership protocol).
- **Branch**: workers commit ONLY their own files onto their card branch; the shared tree's git index contains other cards' staged artifacts — `git add -A` is forbidden.
- **Baseline pin**: upstream HEAD at kickoff = c91a7a6ee3 (v1.4.258); OB-3 records the authoritative pinned tag on its card.
- **Reuse rule**: Hermes native ACP stdio adapter (`hermes-agent/.hermes/bin/hermes-acp.exe`) is reused, not rebuilt (t_a3506e66).

## Risks

- Daemon socket protocol undocumented. Mitigate: start from daemon-main.ts patterns.
- Auto-update clobbers patched binary. Mitigated by pin+cron above.
- Pi-in-Orca model/provider mismatch. Bridge passes COO provider via card metadata.

---

_Drafted+amended 2026-11-13. Owner approved AAA._
