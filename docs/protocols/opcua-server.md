# OPC-UA Server Mode

> Status: **implemented and wired** (#461). The server is started from
> `server/index.ts` when `OPCUA_SERVER_ENABLED=true`, and the `node-opcua`
> binding layer is exercised by a live test that starts a real server on an
> ephemeral loopback port and drives a real client session through it
> (`server/protocols/opcua-server/__tests__/live-binding.test.ts`).
>
> It is **off by default**, binds **loopback only** by default, and refuses
> anonymous access in every environment unless explicitly opted in.

## Overview

0xSCADA already speaks OPC-UA as a **client** (reading from PLCs). *Server mode*
turns that around: it exposes 0xSCADA's own site/tag model as a standard UA
**address space** so external SCADA systems and historians can browse, read and
subscribe to 0xSCADA data.

Source: `server/protocols/opcua-server/`

| File | Responsibility |
|------|----------------|
| `config.ts` | Zod-validated, fail-closed configuration + env loader |
| `security.ts` | Endpoint/security-policy selection + PKI paths (pure) |
| `address-space.ts` | Map sites/tags → UA folders/variables (pure) |
| `user-auth.ts` | UA UserName token → existing `users` table (lookup injected) |
| `storage-data-source.ts` | Latest-value cache + change fan-out (pure) |
| `node-opcua-api.ts` | The single typed `node-opcua` dependency boundary |
| `index.ts` | `OxScadaOpcuaServer` — the node-opcua server lifecycle |
| `runtime.ts` | The opt-in production startup path (storage + tag stream) |

## Enabling it

`OPCUA_SERVER_ENABLED=true` is the **single flag** that turns the subsystem on.
`server/index.ts` calls `startOpcuaServer()` after the HTTP listener is up; with
the flag unset it logs that the subsystem is disabled and returns.

If the subsystem is enabled but cannot be started safely — invalid
configuration, `node-opcua` missing, or the SQLite development fallback in use
(it has no `sites` / `users` / `historian_data` tables) — startup **throws** and
the error is logged. No OPC-UA listener comes up. There is no degraded mode.

```bash
DATABASE_URL=postgres://…  OPCUA_SERVER_ENABLED=true  npm run start
# → opc.tcp://127.0.0.1:4840/0xscada, Basic256Sha256 Sign&Encrypt, no anonymous
```

## Configuration

Every setting is validated by `OpcuaServerConfigSchema`. Unknown keys are
rejected, so a typo'd security flag fails the boot rather than silently
defaulting to something permissive.

| Env var | Config field | Default | Notes |
|---------|--------------|---------|-------|
| `OPCUA_SERVER_ENABLED` | `enabled` | `false` | The single enable flag. |
| `OPCUA_SERVER_HOST` | `host` | `127.0.0.1` | Literal address. Loopback unless `allowRemoteBind`. |
| `OPCUA_SERVER_ALLOW_REMOTE_BIND` | `allowRemoteBind` | `false` | Required for **any** non-loopback bind, wildcard included. |
| `OPCUA_SERVER_PORT` | `port` | `4840` | `0` (ephemeral) is loopback-only. |
| `OPCUA_SERVER_RESOURCE_PATH` | `resourcePath` | `/0xscada` | |
| `OPCUA_SERVER_APPLICATION_URI` | `applicationUri` | `urn:0xscada:server` | |
| `OPCUA_SERVER_NAME` | `serverName` | `0xSCADA OPC-UA Server` | |
| `OPCUA_SERVER_SECURITY_POLICY` | `securityPolicy` | `Basic256Sha256` | `None` is loopback-only and never in staging/production. |
| `OPCUA_SERVER_ALLOW_ANONYMOUS` | `allowAnonymous` | `false` | Off in **every** environment, development included. |
| `OPCUA_SERVER_TRUST_UNKNOWN_CLIENT_CERTS` | `trustUnknownClientCertificates` | `false` | Loopback-only. |
| `OPCUA_SERVER_PKI_FOLDER` | `pkiFolder` | `./pki/opcua-server` | |
| `OPCUA_SERVER_MIN_SAMPLING_MS` | `minSamplingIntervalMs` | `100` | |
| `OPCUA_SERVER_MAX_SESSIONS` | `maxSessions` | `100` | Per endpoint. |
| `NODE_ENV` | `env` | `production` | Unrecognised values fall back to the hardened default. |

Boolean variables are parsed strictly: `true/1/yes/on` and `false/0/no/off`
only. Anything else (`OPCUA_SERVER_ALLOW_ANONYMOUS=maybe`) is an error — an
ambiguous value must never be read as truthy, nor silently as `false`.

### Safety rules (enforced, not merely documented)

These are refused at configuration time *and* again when the security profile is
built, so a caller that hand-builds a config object still cannot get a
permissive server:

1. Any non-loopback `host` — including the `0.0.0.0` / `::` wildcards — requires
   `allowRemoteBind=true`. Exposing the server is a deliberate act.
2. `securityPolicy=None` is permitted only on a loopback bind, and never when
   `env` is `staging` or `production`.
3. `allowAnonymous=true` is refused outright when the policy is `None` on a
   non-loopback bind, and refused in `staging`/`production`.
4. `trustUnknownClientCertificates=true` is permitted only on a loopback bind.
5. An ephemeral port (`0`) is permitted only on a loopback bind.

Note that a *hostname* is never treated as loopback — only literal addresses
(`127.0.0.0/8`, `::1`). Name resolution is not under this process's control, so
a `hosts`/DNS entry must not be able to turn a "loopback-only" deployment into a
routable one. Use `127.0.0.1`.

## Security

| `securityPolicy` | Advertised endpoints | UserName | Anonymous |
|------------------|----------------------|----------|-----------|
| `Basic256Sha256` (default) | `Basic256Sha256` / `SignAndEncrypt` | ✅ | only if `allowAnonymous` |
| `None` (loopback only) | `None`/`None` **and** `Basic256Sha256`/`SignAndEncrypt` | ✅ | only if `allowAnonymous` |

The secure endpoint is always kept, even when `None` is selected. That is
deliberate: node-opcua only advertises an RSA-protected UserName token policy
when a secure policy is present in the endpoint's policy list, so dropping it
would leave anonymous as the only usable identity on the unencrypted endpoint.

Server key material lives under `pkiFolder`
(`own/certs/certificate.pem`, `own/private/private_key.pem`). node-opcua's
`OPCUACertificateManager` provisions self-signed material on first start when
those files are absent. **For production, install CA-issued material at those
paths and populate the `trusted/` list** rather than relying on the self-signed
certificate.

## Authentication

- **UserName / Password** — validated against the existing `users` table.
  `runtime.ts` supplies a Drizzle-backed `UserLookup`; `user-auth.ts` checks the
  record is active and compares the password hash in constant time. There is no
  parallel credential store.
  Supported stored formats: `scrypt$<saltHex>$<hashHex>` and
  `sha256$<saltHex>$<hashHex>`. Any other format (bcrypt, argon2, …) is
  **refused** — never a false accept. See `INTEGRATION(user-store)` in
  `user-auth.ts`: when a shared password verifier lands in the repo, that one
  function is the only thing to replace.
- **Anonymous** — off by default everywhere; explicit opt-in only, and refused
  entirely in staging/production.
- **X509 user identity token** — advertised by node-opcua but **always
  refused** (`BadIdentityTokenRejected`). node-opcua defaults the *user* trust
  store to a process-wide manager built with
  `automaticallyAcceptUnknownCertificate: true`, which would let any client mint
  a throwaway certificate and obtain a session without ever consulting the
  `users` table — anonymous access under a different token type. The server
  therefore supplies its own user certificate manager rooted at
  `<pkiFolder>/userPKI` with auto-accept hardcoded **off**, deliberately not
  tied to `trustUnknownClientCertificates` (that flag is a channel-level
  convenience; accepting an unknown certificate as an *identity* is an
  authentication decision). There is no UA user-certificate enrolment path in
  0xSCADA, so UserName is the supported identity. Pinned by
  `live-binding.test.ts` → "refuses a self-signed X509 identity token".

## Address space

```
Objects/                       (UA NS0, i=85)
└── Sites/                      ns=<i>;s=Sites
    ├── Refinery/               ns=<i>;s=Sites/SITE-01      (one folder per site)
    │   ├── PT-101.PV           ns=<i>;s=Tags/SITE-01/PT-101.PV  (one variable per tag)
    │   └── RUN                 ns=<i>;s=Tags/SITE-01/RUN
    └── SITE-02/
        └── BATCH-ID            ns=<i>;s=Tags/SITE-02/BATCH-ID
```

- **One folder per site**, one **variable per tag**.
- NodeIds are **string** identifiers in the application namespace, built
  deterministically from `siteId` / `tagId` (slashes/percents are escaped).
  `<i>` is the index the address space actually assigns to the application
  namespace — node-opcua's own server namespace already occupies index 1, so
  this is normally 2. Read it from `server.addressSpacePlan.namespaceIndex`.
- Data-type mapping: `boolean → Boolean`, `number → Double`, `string → String`,
  `object`/`array` → JSON-encoded String (`TODO(#461)`: synthesise proper UA
  structured/array types).
- Variables are exposed **read-only**. 0xSCADA has no audited UA write path yet,
  so the server must not advertise one; `accessLevel`/`userAccessLevel` are set
  explicitly rather than inherited from node-opcua's defaults.

### Where the data comes from

- **Sites** — `SELECT id, name FROM sites`.
- **Tag catalogue** — there is no dedicated tag table; the tag id space is what
  the historian has recorded, so `runtime.ts` groups `historian_data` by
  `(tag_id, site_id)` and derives the UA type from whether a `string_value` was
  ever stored.
- **Live values** — `tagStreamServer.onTagUpdate(...)`, the same stream the
  gateway scan loop and the field simulator already publish to. Each update is
  pushed into `StorageTagDataSource`, which sets the value on the matching UA
  variable; node-opcua turns that into a `DataChangeNotification` for every
  subscribed client.

## Tests

Unit tests (`npx vitest run server/protocols/opcua-server`):

- `config.test.ts` — fail-closed defaults, bind/security rules, strict env parsing.
- `security.test.ts` — profile selection and every refusal, independent of the schema.
- `address-space.test.ts` — mapping, NodeId scheme, ordering, dedup, orphans.
- `user-auth.test.ts` — password verification, auth flow, node-opcua's
  *callback-style* `isValidUserAsync` contract.
- `storage-data-source.test.ts` — type inference, caching, subscribe fan-out.
- `runtime.test.ts` — the startup gate: off unless enabled, throws instead of
  relaxing on invalid config, refuses the SQLite fallback.
- `live-binding.test.ts` — **the real thing**: starts the server on
  `127.0.0.1:0`, connects a genuine node-opcua client, browses the site folder,
  reads a tag through the UA read service, subscribes and receives a
  `DataChangeNotification` for a pushed update, then shuts down. A second suite
  starts a server with the shipped `allowAnonymous: false` and asserts that an
  anonymous session is refused (no Anonymous token policy is advertised), a
  valid username/password from the user store is accepted, and a bad password or
  unknown user gets `BadUserAccessDenied`.

  If `node-opcua` cannot be loaded the live suite **skips with a printed
  reason** rather than asserting against a stand-in.

## Interoperability check with opcua-asyncio

The vitest suite above covers the binding layer with node-opcua on both ends.
The following manual procedure additionally checks a *third-party* stack, which
is what actually demonstrates UA interoperability. It has **not** been executed
in CI (no Python toolchain there).

```bash
pip install asyncua
DATABASE_URL=…  OPCUA_SERVER_ENABLED=true \
OPCUA_SERVER_SECURITY_POLICY=None NODE_ENV=development npm run dev
# Endpoint: opc.tcp://127.0.0.1:4840/0xscada
```

```python
import asyncio, time
from asyncua import Client

ENDPOINT = "opc.tcp://127.0.0.1:4840/0xscada"

class SubHandler:
    def __init__(self):
        self.latencies = []
    def datachange_notification(self, node, val, data):
        src = data.monitored_item.Value.SourceTimestamp
        if src:
            self.latencies.append((time.time() - src.timestamp()) * 1000)
        print("change", node, val)

async def main():
    client = Client(url=ENDPOINT)
    # Anonymous is refused by default — supply a real user from the `users` table.
    client.set_user("ua-operator")
    client.set_password("…")
    async with client:
        ns = await client.get_namespace_index("urn:0xscada:server")
        sites = await client.nodes.objects.get_child([f"{ns}:Sites"])
        for site in await sites.get_children():
            print("site folder:", await site.read_browse_name())
            for tag in await site.get_children():
                print("  tag:", await tag.read_browse_name(), "=", await tag.read_value())

        handler = SubHandler()
        sub = await client.create_subscription(50, handler)
        first_site = (await sites.get_children())[0]
        first_tag = (await first_site.get_children())[0]
        await sub.subscribe_data_change(first_tag)
        await asyncio.sleep(5)
        assert handler.latencies, "no DataChangeNotification received"
        print(f"worst latency: {max(handler.latencies):.1f} ms")
        await sub.delete()

asyncio.run(main())
```

For the secure profile, drop `OPCUA_SERVER_SECURITY_POLICY` (Basic256Sha256 is
the default), point the client at the generated server certificate under
`pkiFolder`, and call `client.set_security(...)` with
`Basic256Sha256_SignAndEncrypt`.

## Known gaps

- **No UA writes.** All variables are read-only. Wiring writes means routing
  them through the same authorisation the other actuating routes use
  (`requireControlPlaneAccess`) plus an audit trail — `TODO(#461)`.
- **Structured types.** `object` / `array` tags are exposed as JSON strings
  rather than UA ExtensionObjects / arrays.
- **Self-signed certificates.** Fine for a loopback bind; production deployments
  should install CA-issued material and manage the trust list.
