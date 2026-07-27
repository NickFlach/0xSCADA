# Agent Marketplace & Plugin System

**Issue:** [#217](https://github.com/NickFlach/0xSCADA/issues/217) — feature [13.6] of
[ADR-0013: Autonomous Agent Architecture](../decisions/ADR-0013-autonomous-agent-architecture.md).

**Code:** `server/services/marketplace/`, `server/routes/marketplace.ts`,
`shared/types/marketplace.ts`, `migrations/0011_agent_marketplace.sql`.

---

## What this is

A registry of plugin **manifests** — metadata describing a plugin's id, semver
version, declared capabilities, config schema and dependencies — plus an
install record for each plugin an operator has explicitly installed, carrying
the configuration and the capabilities actually granted to it.

## What this is not

**It is not a code-distribution channel.** No plugin code is uploaded,
downloaded, or dynamically loaded, ever. A published manifest is metadata; it
cannot become executable on its own.

**It is not a security sandbox.** Executable handlers run in-process, in the
server's own Node isolate. That is not a boundary against hostile code: a
malicious handler could reach `process`, `require`, the filesystem or the
event loop regardless of what its manifest declares. Containing untrusted code
would require process or VM isolation (a worker thread with a restricted
module graph, a child process, or a separate container). This repository does
not implement that, and this document does not claim it does.

**No money, tokens, licences or signatures move.** There is no payment path,
no plugin signing and no signature verification. Nothing in the code pretends
otherwise.

## Why in-process execution is nevertheless defensible here

Because there is no untrusted code to contain.

The only executable handlers come from `server/services/marketplace/builtin/`
— first-party modules compiled into this server and bound to a plugin id by
`AgentMarketplace.registerImplementation`, which is called from
`MarketplaceService.initialize()` at startup. There is deliberately **no HTTP
route** to `registerImplementation`.

A manifest published over the API by an operator therefore installs, reports
`implementationState: "unavailable"`, and **refuses to start**:

```
POST /api/marketplace/plugins/my-plugin/start
409 { "error": "... no implementation is registered in this build", "code": "not-implemented" }
```

Adding a plugin that can actually run means adding it to `builtin/` in a
reviewed commit and shipping a new build. That is the containment story.

If third-party code execution is ever wanted, it needs an isolation boundary
first; that work is out of scope for #217 and must not be started by relaxing
`registerImplementation`.

## What the capability system does do

Each manifest declares `requiredCapabilities`. At install time the operator
grants a subset of them. At invocation time the handler receives a
`PluginHostContext` whose capability accessors are **enforcing getters**:

| Accessor | Capability |
| --- | --- |
| `host.tags` | `tags:read` |
| `host.alarms` | `alarms:read` |
| `host.emitEvent` | `events:emit` |
| `host.log` | `log` |

Reading an accessor whose capability is either **undeclared** in the manifest
or **ungranted** at install time throws `MarketplaceError('capability-denied')`
and emits a `plugin-capability-denied` audit event (forwarded to the log by
`MarketplaceService` and counted in `PluginHealth.capabilityDenials`). The
invocation then fails with `code: "capability-denied"`.

The deliberate design choice here is that a denial **throws** rather than
leaving the property undefined. An absent property is something a plugin can
silently skip; a throw cannot be ignored, and it is visible in the audit trail.
`host.capabilities` is the supported way for a cooperative plugin to
feature-detect before reaching.

`host.config` is frozen, so a handler cannot rewrite its own installation.

Scope, stated precisely: this constrains a **cooperative** plugin's access to
host services at the host-context boundary. It does not constrain a hostile
one.

## Invocation bounds

* **Wall-clock timeout** — every invocation races a timer
  (`invokeTimeoutMs`, default 5000 ms); a timeout returns `code: "timeout"`.
  Stated precisely: the timer runs on the event loop, so it bounds a handler
  that **yields** (async work, I/O, awaited promises). It cannot interrupt a
  handler that blocks the event loop synchronously — a `while` loop owns the
  thread until it returns, and the call is then reported as whatever it
  eventually produced, not as a timeout. Pre-emption needs the same
  process/VM isolation boundary this document says is absent; the bound is
  acceptable only because handlers are reviewed first-party code.
  `code: "timeout"` is produced solely by the host's own timer error type, so
  a handler cannot mislabel an ordinary failure as a host timeout.
* **Windowed failure tracking** — the last `errorWindow` (default 20)
  outcomes feed `PluginHealth.windowedErrorRate`.
* **Auto-disable** — `autoDisableAfter` (default 5) consecutive failures move
  the plugin to `error`, stop it, emit `plugin-auto-disabled`, and persist the
  decision. An operator clears it with `enable` + `start`.

## Ownership: closing the manifest hijack

The original implementation let anyone `POST /plugins` and republish any
plugin id with a bumped version. Two things fix that.

1. **Every route carries an explicit scope** (below). There is no permissive
   or no-op guard anywhere in the router.
2. **The first publish of an id records a durable owner** — the authenticated
   control-plane principal, taken from `controlPlanePrincipal(req).name`,
   never from the request body (`ManifestSchema` is `.strict()`, so a body
   carrying a `publisher` field is rejected with 400). Every later publish of
   that id must come from the same principal, and must carry a **strictly
   newer** semver. Re-publishing an existing version is refused with
   `409 version-conflict`; publishing from a different principal is refused
   with `403 ownership-conflict`.

Built-in plugins are owned by the reserved principal `system:builtin`, and the
HTTP publish path refuses any principal name beginning with `system:`, so a
configured API key cannot impersonate the built-in publisher.

Uninstalling a plugin does **not** release its registry entry or its ownership
record: releasing the id would re-open it to a hijack.

## Authorization matrix

| Route | Scope |
| --- | --- |
| `GET /api/marketplace/plugins` | `marketplace.read` |
| `GET /api/marketplace/plugins/:id` | `marketplace.read` |
| `GET /api/marketplace/installed` | `marketplace.read` |
| `GET /api/marketplace/plugins/:id/health` | `marketplace.read` |
| `GET /api/marketplace/health` | `marketplace.read` |
| `GET /api/marketplace/status` | `marketplace.read` |
| `POST /api/marketplace/plugins` | `marketplace.publish` |
| `POST /api/marketplace/plugins/:id/install` | `marketplace.install` |
| `POST /api/marketplace/plugins/:id/update` | `marketplace.install` |
| `PUT /api/marketplace/plugins/:id/config` | `marketplace.install` |
| `POST /api/marketplace/plugins/:id/start\|stop` | `marketplace.install` |
| `POST /api/marketplace/plugins/:id/enable\|disable` | `marketplace.install` |
| `POST /api/marketplace/plugins/:id/invoke` | `marketplace.invoke` |
| `DELETE /api/marketplace/plugins/:id` | `marketplace.uninstall` |

Lifecycle transitions sit under `marketplace.install` because they change the
state of an installed plugin. They are deliberately not reachable with
`marketplace.invoke`, which only lets a caller run something an operator has
already installed and started.

`CONTROL_ROUTE_POLICIES` also carries a `marketplace-control` entry, so the
central gateway floor for `/api/marketplace` is the four action scopes rather
than the generic `write` scope.

The matrix is enforced by `server/routes/__tests__/marketplace-auth.test.ts`:
anonymous → 401, unknown credential → 401, valid credential with the wrong
scope → 403, exact scope → its expected status, for every route.

## Persistence

| State | Durable? | Where |
| --- | --- | --- |
| Registry manifest + version | yes | `plugin_registry` |
| Ownership record (`publisher`) | yes | `plugin_registry.publisher` |
| Install counter | yes | `plugin_registry.installs` |
| Installed manifest + version | yes | `plugin_installations` |
| Validated config | yes | `plugin_installations.config` |
| Granted capabilities | yes | `plugin_installations.granted_capabilities` |
| Installing principal | yes | `plugin_installations.installed_by` |
| Lifecycle status (incl. auto-disable) | yes | `plugin_installations.status` |
| Invocation counters, failure window, uptime | **no** | in-process only |
| Registered implementations | **no** | compiled into the build |

The two persisted tables are created by
`migrations/0011_agent_marketplace.sql` and declared in `shared/schema.ts`
(`pluginRegistry`, `pluginInstallations`), reached through `server/storage.ts`
so both the Postgres and the SQLite development back-end work.

The in-memory exceptions are deliberate and are not authorization state:

* **Invocation counters, failure window, uptime** are telemetry about the
  current process. A restart legitimately resets them. The *decision* they
  produce (auto-disable → `status: "error"`) is persisted.
* **Registered implementations** are code, not data. They come from the build.

A plugin recorded as `running` is restored as `stopped`, because it is not
running after a restart and the record must not claim it is. `disabled` and
`error` survive verbatim — a restart must not clear an operator's disable or
an auto-disable.

If the database is unavailable the service falls back to a non-durable
in-memory store and logs a warning saying plainly that ownership and grants
will not survive a restart. It does not pretend the state is durable.

`server/services/marketplace/__tests__/marketplace-persistence.test.ts`
exercises this against a real file-backed database, closing and reopening it
between assertions, and re-asserts the hijack refusal on the other side of the
restart.

## The built-in plugin

`tag-threshold-monitor` (`builtin/tag-threshold-monitor.ts`) is a real
first-party plugin, not a demo stub. It reads a configured tag through
`host.tags`, classifies the latest sample against `highLimit` / `lowLimit` and
a `maxAgeSeconds` staleness bound, emits a `tag-threshold-breach` host event
when the tag is out of band, and returns the evaluation.

```
POST /api/marketplace/plugins/tag-threshold-monitor/install
     { "config": { "tagId": "PT-101", "highLimit": 90, "lowLimit": 10 },
       "grants": ["tags:read", "events:emit", "log"] }
POST /api/marketplace/plugins/tag-threshold-monitor/start
POST /api/marketplace/plugins/tag-threshold-monitor/invoke
200  { "success": true, "code": "ok",
       "output": { "tagId": "PT-101", "state": "high", "value": 97, ... } }
```

That whole sequence is exercised end to end over HTTP against a live tag in
the auth-matrix test.

## Deviation from ADR-0013

ADR-0013 says plugins "run in sandboxed contexts". This implementation does
**not** provide a sandbox in the isolation sense, and says so above. What it
provides is capability scoping plus fault containment for first-party code,
and a trust model in which no third-party code can execute at all. Lifting
that restriction requires a real isolation boundary first.

## Known gaps

* No process/VM isolation, therefore no third-party code execution.
* No plugin signing or signature verification.
* No payment, licensing or token flow.
* `alarms:read` currently resolves to an empty list: no read-only projection
  of active alarms is wired to the marketplace on this branch. Plugins granted
  the capability see an empty list rather than fabricated alarms.
