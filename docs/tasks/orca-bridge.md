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

## Card Graph (Active Pipeline)

Live table — maintained by OB-0 (orchestrator). Last sync: 2026-11-16 15:45 +07.

| ID   | Card       | Title                                            | Assignee     | Parents   | Status @sync                      |
| ---- | ---------- | ------------------------------------------------ | ------------ | --------- | --------------------------------- |
| OB-0 | t_03c15813 | Coordination throughout phase                    | orchestrator | -         | running                           |
| OB-1 | t_0341250c | Architecture doc + daemon HTTP gateway patch     | pi           | -         | running (branch ob1-http-gateway) |
| OB-2 | t_f62d27e1 | ACP adapter module (card to agent prompt)        | pi           | OB-1      | blocked → awaiting OB-1           |
| OB-3 | t_bc1557a7 | Pin version, disable auto-update, build env prep | home-lab     | -         | running                           |
| OB-4 | t_4f3bc487 | Build patched binary + install + smoke           | home-lab     | OB-2,OB-3 | blocked → awaiting OB-2+OB-3      |
| OB-5 | t_e2f9955d | Security review: bridge auth + RCE surface       | qa-security  | OB-4      | blocked → awaiting OB-4           |
| OB-6 | t_5ddddf6a | Hermes profile orca-bridge + smoke harness       | pi           | OB-2      | blocked → awaiting OB-2           |

Dependency edges (OB-1→OB-2, OB-2/OB-3→OB-4, OB-4→OB-5, OB-2→OB-6) were missing at creation; orchestrator added them 2026-11-16. Cards sit in `blocked`, so promotion is manual: OB-0 unblocks each successor only when its parents are done.

## Pinned Contracts (orchestrator decisions — all cards build against these)

- **Endpoint**: bind `127.0.0.1:9876` only. `GET /health` → 200 `{"ok":true}` iff `Authorization: Bearer $ORCA_BRIDGE_TOKEN`; else 401. Token never logged (OB-5 greps for it).
- **Branch**: workers commit ONLY their own files onto their card branch; the shared tree's git index contains other cards' staged artifacts — `git add -A` is forbidden.
- **Baseline pin**: upstream HEAD at kickoff = c91a7a6ee3 (v1.4.258); OB-3 records the authoritative pinned tag on its card.
- **Reuse rule**: Hermes native ACP stdio adapter (`hermes-agent/.hermes/bin/hermes-acp.exe`) is reused, not rebuilt (t_a3506e66).

## Risks

- Daemon socket protocol undocumented. Mitigate: start from daemon-main.ts patterns.
- Auto-update clobbers patched binary. Mitigated by pin+cron above.
- Pi-in-Orca model/provider mismatch. Bridge passes COO provider via card metadata.

---

_Drafted+amended 2026-11-13. Owner approved AAA._
