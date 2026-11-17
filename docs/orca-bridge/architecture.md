# Orca Bridge — Architecture

**Card**: OB-1 (this document + `src/main/daemon/endpoint/http-gateway.ts`). Follow-ups: OB-2 ACP
adapter, OB-4 patched binary, OB-5 security review. See `docs/tasks/orca-bridge.md` for the brief.

## What The Bridge Is

An HTTP control surface that lets an external orchestrator (the COO) treat this Orca install as a
first-class execution node: list the agents Orca can run, dispatch a card to one of them, steer the
running session, and gate its permission requests. It is a thin gateway over the same agent runtime
the IDE uses — ACP launch specs in, ACP prompts out — not a second agent implementation.

```
COO ──HTTP/1.1 + bearer──▶ 127.0.0.1:46133 ──▶ routes (OB-2) ──▶ AcpLaunchSpec / session store
                                    ▲
Orca IDE ── Unix socket (unchanged) ─┴── daemon process
```

## HTTP Endpoint Contract

### Transport and binding

| Property | Value                                                                                        |
| -------- | -------------------------------------------------------------------------------------------- |
| Process  | the existing terminal daemon (`daemon-entry.ts` → `startDaemon`)                             |
| Address  | `127.0.0.1` only — never `0.0.0.0`, never a Unix socket, never IPv6 `::`                     |
| Port     | `ORCA_BRIDGE_PORT`, default `46133`; invalid or out-of-range values fall back to the default |
| Protocol | plain HTTP/1.1, request/response. No TLS (loopback-only), no websockets in v1                |
| Module   | `src/main/daemon/endpoint/http-gateway.ts` (`startHttpGateway` / `stopHttpGateway`)          |

The gateway is a sibling listener inside the daemon process. It reuses the daemon's lifecycle, so it
starts after the socket endpoint wins publication and stops before the daemon tears its resources
down. No separate service, no new launcher, no new auto-start path.

### Authentication

| Item                               | Rule                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Secret                             | `ORCA_BRIDGE_TOKEN`, read from the daemon's environment at start       |
| Presentation                       | `Authorization: Bearer <token>`, compared with a constant-time digest  |
| Token unset/empty                  | **the gateway does not listen at all** — shipped builds are unaffected |
| Missing / wrong / malformed header | `401 {"error":"unauthorized"}`, before any routing happens             |

Every request without exception passes the bearer check first; there is no allow-listed path and no
cookie or query-parameter fallback. Responses always carry `Cache-Control: no-store`. The token is a
shared secret for a single machine — it is never written to disk by the bridge, never logged, and
never forwarded to agents. Rotation means restarting the daemon with a new environment value.

Because the listener is loopback-only, the threat model is "any process on this host", not "the
network". The token exists so that a stray local process cannot drive Orca into running agents; OB-5
owns the full RCE-surface review, including whether per-route scopes are needed once dispatch lands.

### GET /health

Implemented now. Requires a valid bearer token.

```http
GET /health HTTP/1.1
Authorization: Bearer $ORCA_BRIDGE_TOKEN

200 OK
{"ok":true,"service":"orca-bridge"}
```

Unauthenticated: `401 {"error":"unauthorized"}`. Unknown path with a valid token:
`404 {"error":"not_found","path":"/…"}`. A path whose `:param` escapes are undecodable gets
`400 {"error":"invalid_request"}`. A handler that throws after starting no response gets
`500 {"error":"internal_error"}`; the gateway never crashes the daemon.

### Route table (OB-2 implements the bodies)

Paths are versioned under `/v1`. `:id` is a bridge session id owned by OB-2's adapter, not an ACP
wire id. All routes require the bearer token. OB-1 ships only `/health`; the rest are the contract
OB-2 codes against.

| Method | Path                     | Purpose                                                   | Success              |
| ------ | ------------------------ | --------------------------------------------------------- | -------------------- |
| GET    | `/health`                | liveness + gateway identity (shipped in OB-1)             | 200 `{ok,service}`   |
| GET    | `/v1/agents`             | agent catalog: every `AcpLaunchSpec` this host can launch | 200 `{agents:[…]}`   |
| GET    | `/v1/agents/:agent`      | one catalog entry: models, permission modes, availability | 200 `{agent}`        |
| POST   | `/v1/sessions`           | dispatch a card → start session, inject first prompt      | 202 `{session}`      |
| GET    | `/v1/sessions`           | list bridge sessions and their states                     | 200 `{sessions:[…]}` |
| GET    | `/v1/sessions/:id`       | read back status plus accumulated response text           | 200 `{session,text}` |
| POST   | `/v1/sessions/:id/steer` | inject a follow-up prompt into a live session             | 202 `{accepted}`     |
| POST   | `/v1/sessions/:id/gate`  | answer a pending permission request (allow/deny)          | 202 `{resolved}`     |
| GET    | `/v1/sessions/:id/gate`  | the pending gate the COO must decide, if any              | 200 `{pending}`      |
| DELETE | `/v1/sessions/:id`       | stop the session and drop bridge state                    | 202 `{stopped}`      |

Conventions OB-2 must keep:

- `400 {"error":"invalid_request",…}` for a malformed body, `404` for an unknown id,
  `409 {"error":"gate_pending"}` while a gate blocks the session, `503 {"error":"agent_unavailable"}`
  when the launch spec is not runnable on this host.
- Dispatch is asynchronous: `202` after the session exists and the prompt is queued. The COO polls
  `GET /v1/sessions/:id` (or a future SSE route) for readback; no request blocks on agent runtime.
- Bodies are `application/json`, capped by OB-2 at a documented size; the gateway itself does not
  buffer bodies, handlers read `ctx.req` as a stream.

### Extension point

```ts
import { registerBridgeRoute, sendBridgeJson } from '../endpoint/http-gateway'

const unregister = registerBridgeRoute({
  method: 'POST',
  path: '/v1/sessions/:id/steer',
  handler: async ({ params, res, req }) => {
    // OB-2: read the prompt from `req`, drive the ACP adapter, then:
    sendBridgeJson(res, 202, { accepted: true })
  }
})
```

`registerBridgeRoute({ method, path, handler })` matches on exact segment count with `:name`
captures exposed as `ctx.params`. It returns an unregister function; OB-2 registers at daemon start
and holds the returned closures. `sendBridgeJson(res, status, body)` is the only sanctioned reply
helper so headers stay uniform. Registering a second route for the same method+path replaces the
first, which keeps hot-reload of adapter modules from double-firing handlers.

## Daemon Integration Point

The gateway starts inside the daemon process, next to — and completely independent of — the Unix
socket bound in `src/main/daemon/server/daemon-server-lifecycle.ts`:

```ts
await server.start() // binds + publishes the canonical socket endpoint
await startHttpGateway() // separate TCP listener on 127.0.0.1, no filesystem endpoint
```

(`startDaemon` in `src/main/daemon/server/daemon-main.ts`; `shutdown()` stops the gateway first, so
no bridge request can arrive while the daemon drains.)

### Endpoint-ownership rules it must respect

`src/main/daemon/AGENTS.md` is the authority. The relevant consequences for this module:

- **The gateway never touches the canonical socket path.** It binds a TCP port and nothing else: no
  `link`, `rename`, `unlink`, `stat` or existence check of any socket, PID file, or runtime-dir entry,
  and it creates no scratch names in the daemon runtime directory.
- **It is not an endpoint publisher.** Only a daemon publishing itself onto the canonical endpoint may
  mutate that directory entry. The gateway has no opinion about which daemon owns the socket and never
  treats socket existence as evidence of anything.
- **It starts strictly after publication wins.** `server.start()` rejects when this process loses the
  endpoint, so `startDaemon` throws before `startHttpGateway()` runs. Exactly one live daemon per host
  therefore holds port 46133, and a losing duplicate cannot serve bridge traffic.
- **It never extends the socket protocol.** Bridge routes call in-process modules; they do not add RPC
  methods, frames, or protocol versions to the Unix socket, so client compatibility is untouched.
- **Its own failures stay its own.** A bind failure (port busy, EPERM) logs a warning and returns
  `null`; the daemon keeps serving terminals. Nothing in the gateway can make the daemon retire,
  go idle, or lose ownership — it holds no sessions and does not count toward idleness.

## Agent Lifecycle Mapping

Four stages, each owned by an existing module. OB-2's adapter
(`src/main/acp/bridge/orca-bridge-acp-adapter.ts`) is the only new code in the path; it maps a COO
card onto what Orca already does for its own Chat tabs.

| Stage                | Bridge route                               | Existing machinery                                                                                                                               | What happens                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Launch spec       | `GET /v1/agents`                           | `acpLaunchSpecFor()` (`src/main/acp/launch/acp-launch-registry.ts`), `AcpLaunchSpec` (`acp-launch-contract.ts`)                                  | Enumerate every agent with an ACP launch spec: command, args/env builder, dialect, model discovery, permission modes. Availability = the spec's install directories / managed runtime resolve on this host. Zero code per new agent.                                 |
| 2. Session start     | `POST /v1/sessions`                        | spec → launch command + account home resolution (`acp-launch-command.ts`), ACP `initialize` then `session/new` (`protocol/acp-session-setup.ts`) | Resolve the card's `agent`, workspace path, model and permission mode into a spec, spawn the agent process, create the session. The bridge stores `{bridgeSessionId → acp sessionId, agent, cwd}` and returns `202`.                                                 |
| 3. Prompt injection  | body of `POST /v1/sessions`, then `/steer` | `protocol/acp-session-runtime.ts` → `session/prompt`                                                                                             | The card's prompt (or the COO's steer text) is sent as one ACP prompt turn through the session runtime's serialized prompt queue, so a steer cannot interleave mid-turn.                                                                                             |
| 4. Response readback | `GET /v1/sessions/:id`                     | notification/turn handling in `acp-session-runtime.ts`, timeline + journal (`src/main/acp/timeline`, `src/main/acp/journal`)                     | Collect the agent's streamed chunks into text the COO can poll, plus terminal state: `running`, `awaiting_gate`, `done`, `failed`. Readback is a projection of what Orca already journals — no parallel transcript.                                                  |
| Gate (side channel)  | `GET`/`POST /v1/sessions/:id/gate`         | `session/request_permission` interception in `acp-session-runtime.ts`                                                                            | When the agent asks for permission, the adapter parks the request and marks the session `awaiting_gate`. The COO's answer (`allow`/`deny`) resolves the parked ACP request. Nothing is auto-approved: a gate with no answer blocks that session, it never escalates. |

### Mapping rules

- **Card → spec, not card → shell.** A dispatch names an `agent` key from the catalog; the bridge never
  accepts a command line, cwd-outside-the-workspace path, or arbitrary env from HTTP.
- **Provider/model come from the card metadata** and are validated against the spec's model discovery,
  because a Pi-in-Orca mismatch is silent (brief risk #3).
- **Permission mode comes from the card but can only narrow** what the spec's `permissionModeConfig`
  allows; full-access launch stays an explicit, host-side decision.
- **Session lifetime is the bridge's only state.** If the daemon restarts, sessions die with it and the
  COO re-dispatches; OB-1/OB-2 add no session persistence onto the filesystem.

## Configuration

| Env var             | Read by                  | Effect                                                                                                         |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ORCA_BRIDGE_TOKEN` | gateway (daemon process) | bearer secret. Unset/empty ⇒ `startHttpGateway()` returns `null` and nothing listens. This is the only switch. |
| `ORCA_BRIDGE_PORT`  | gateway                  | TCP port, default 46133; non-numeric or out-of-range values fall back to the default.                          |

Both are process environment for the daemon, set by whoever launches it. There is no settings-UI
switch and no on-disk enable flag in v1.

## OB-1 Scope

Delivered here: this document, `http-gateway.ts` (loopback listener, bearer gate, `/health`,
`registerBridgeRoute`), and the env-gated start/stop hook in `daemon-main.ts`.

Explicitly **not** in OB-1: agent catalog, dispatch, steer, gate handlers, the ACP adapter, the Hermes
profile, the smoke harness (OB-2/OB-6), and pinning the build against auto-update (OB-3). Until those
land, an enabled gateway answers `/health` and returns `404` for everything else.

## OB-2 Scope

Delivered here: the ACP adapter (`src/main/acp/bridge/`: `orca-bridge-acp-adapter.ts`,
`orca-bridge-acp-session.ts`, `orca-bridge-card-plan.ts`, `orca-bridge-sessions.ts`,
`orca-bridge-session-view.ts`) and its route registration in `daemon-main.ts`, which fills every
`/v1` body above on the OB-1 gateway.

- **Request bodies are capped at 1 000 000 bytes** (`BRIDGE_BODY_LIMIT`); larger, empty and
  non-JSON bodies answer `400 {"error":"invalid_request",…}`.
- **An assignee with no ACP launch spec, or one whose program this host cannot resolve, answers
  `503 {"error":"agent_unavailable",…}`** — the adapter itself throws rather than no-op'ing.
- **A steer while a gate is parked answers `409 {"error":"gate_pending",…}`**; answering a gate
  that is not parked answers `409 {"error":"no_gate_pending"}`.
- **Model ids are only known once a session advertises them**, so the catalog reports the agent's
  `modelDiscovery` kind instead of a model list; a model the session refused appears in
  `session.skipped`, which is also the honest report for every other degraded card capability.
