# OPC-UA Server Mode

> Status: **scaffold-core** (#461). The pure address-space mapping, security-policy
> selection, user-authentication, and configuration are implemented and unit-tested.
> The `node-opcua` runtime wiring is real but has not been executed in CI (the
> dependency is not yet installed). Items needing a live run or certificate
> material are marked `TODO(#461)` in the source.

## Overview

0xSCADA already speaks OPC-UA as a **client** (reading from PLCs). *Server mode*
turns that around: it exposes 0xSCADA's own site/tag model as a standard UA
**address space** so external SCADA systems and historians can browse and
subscribe to 0xSCADA data.

Source: `server/protocols/opcua-server/`

| File | Responsibility | Pure? |
|------|----------------|-------|
| `address-space.ts` | Map sites/tags → UA folders/variables | ✅ pure, fully tested |
| `security.ts` | SecurityPolicy selection + cert helper | policy pure; cert helper runtime |
| `user-auth.ts` | UserName token → existing user store | ✅ pure (lookup injected) |
| `config.ts` | Zod-validated configuration | ✅ pure |
| `storage-data-source.ts` | Bridge storage + tag-stream → server | ✅ pure (deps injected) |
| `index.ts` | `node-opcua` server lifecycle | runtime wiring |

## Address space

```
Objects/                       (UA NS0, i=85)
└── Sites/                      ns=1;s=Sites
    ├── SITE-01/                ns=1;s=Sites/SITE-01      (one folder per site)
    │   ├── PT-101.PV           ns=1;s=Tags/SITE-01/PT-101.PV   (one variable per tag)
    │   └── RUN                 ns=1;s=Tags/SITE-01/RUN
    └── SITE-02/
        └── BATCH-ID            ns=1;s=Tags/SITE-02/BATCH-ID
```

- **One folder per site**, one **variable per tag**.
- NodeIds are **string** identifiers in the application namespace (`ns=1`), built
  deterministically from `siteId` / `tagId` (slashes/percents are escaped).
- Data-type mapping: `boolean → Boolean`, `number → Double`, `string → String`,
  `object`/`array → BaseDataType` (exposed as JSON string in this scaffold —
  `TODO(#461)` to synthesise proper UA structured/array types).
- Variables are read-only unless the source tag is marked `writable`.

## Configuration

```typescript
{
  enabled: false,                       // start at boot?
  host: '0.0.0.0',
  port: 4840,                           // UA default
  resourcePath: '/0xscada',             // → opc.tcp://0.0.0.0:4840/0xscada
  applicationUri: 'urn:0xscada:server',
  env: 'development',                   // drives security selection
  pkiFolder: './pki/opcua-server',
  minSamplingIntervalMs: 100,
  maxSessions: 100,
}
```

Default endpoint: **`opc.tcp://0.0.0.0:4840/0xscada`**.

## Security

| Environment | SecurityPolicy | Mode | Anonymous | Untrusted certs |
|-------------|----------------|------|-----------|-----------------|
| development / test | `None` + `Basic256Sha256` | `None` / `SignAndEncrypt` | ✅ | auto-accept |
| staging / production | `Basic256Sha256` only | `SignAndEncrypt` | ❌ | rejected (manage trust list) |

Certificate generation helper (`ensureServerCertificate`) creates a self-signed
server cert under `pkiFolder` using `node-opcua`'s `OPCUACertificateManager`.
`TODO(#461)`: replace self-signed material with CA-issued certs in production.

## Authentication

- **Anonymous** — dev only.
- **UserName / Password** — validated against the existing `users` table.
  `user-auth.ts` takes an injected `UserLookup` (so it is DB-decoupled and
  testable) and verifies the stored password hash with a constant-time compare.
  Supported hash formats: `scrypt$…`, `sha256$…`. bcrypt is intentionally
  **refused** (never a false accept) until the shared auth verifier lands —
  `INTEGRATION(user-store)` in source.

## Subscriptions

Each UA Variable has a refresh getter (pull on read/sample) and is also pushed
on change: the `StorageTagDataSource.pushTagUpdate()` path is fed by the existing
tag-stream fabric (`broadcastTagUpdate({ tagName, value, quality, timestamp })`),
calls `setValueFromSource` on the matching node, and `node-opcua` emits a
`DataChangeNotification` to subscribed clients.

## Usage

```typescript
import { createOpcuaServer } from './server/protocols/opcua-server';
import { StorageTagDataSource } from './server/protocols/opcua-server/storage-data-source';

const dataSource = new StorageTagDataSource({
  loadSites: () => storage.getSites(),          // INTEGRATION(storage)
  loadTagDefs: () => storage.getTagCatalogue(), // INTEGRATION(storage): TODO
});

const server = createOpcuaServer({
  config: { enabled: true, env: process.env.NODE_ENV },
  dataSource,
  userLookup: async (username) => storage.getUserByUsername(username),
});

await server.start();   // listens on opc.tcp://0.0.0.0:4840/0xscada
// … forward tag updates: dataSource.pushTagUpdate(update)
await server.stop();
```

## Conformance smoke test (opcua-asyncio)

> **Cannot be executed in this worktree / CI** (no Python, no installed
> `node-opcua`, no live server). This is the manual procedure for the
> acceptance criterion "opcua-asyncio client browses and subscribes; tag updates
> arrive within 200 ms".

### Prerequisites

```bash
npm install              # installs node-opcua
pip install asyncua      # opcua-asyncio Python client
```

### Run the server (dev / SecurityPolicy=None)

```bash
OPCUA_SERVER_ENABLED=true NODE_ENV=development npm run dev
# Endpoint: opc.tcp://localhost:4840/0xscada
```

### Browse + subscribe script

Save as `scripts/opcua_conformance.py`:

```python
import asyncio, time
from asyncua import Client

ENDPOINT = "opc.tcp://localhost:4840/0xscada"

class SubHandler:
    def __init__(self):
        self.latencies = []
    def datachange_notification(self, node, val, data):
        # 0xSCADA encodes source timestamp; compare to arrival.
        src = data.monitored_item.Value.SourceTimestamp
        if src:
            self.latencies.append((time.time() - src.timestamp()) * 1000)
        print("change", node, val)

async def main():
    async with Client(url=ENDPOINT) as client:
        # 1. Browse: Objects → Sites → per-site folders → tag variables
        objects = client.nodes.objects
        sites = await objects.get_child(["1:Sites"])
        for site in await sites.get_children():
            print("site folder:", await site.read_browse_name())
            for tag in await site.get_children():
                print("  tag:", await tag.read_browse_name(),
                      "=", await tag.read_value())

        # 2. Subscribe and measure data-change latency
        handler = SubHandler()
        sub = await client.create_subscription(50, handler)
        first_site = (await sites.get_children())[0]
        first_tag = (await first_site.get_children())[0]
        await sub.subscribe_data_change(first_tag)

        # 3. Drive an update on the 0xSCADA side, then assert latency < 200ms
        await asyncio.sleep(5)
        assert handler.latencies, "no DataChangeNotification received"
        worst = max(handler.latencies)
        print(f"worst latency: {worst:.1f} ms")
        assert worst < 200, f"latency {worst:.1f}ms exceeds 200ms budget"
        await sub.delete()

asyncio.run(main())
```

```bash
python scripts/opcua_conformance.py
```

### For the secure profile (production)

```bash
NODE_ENV=production OPCUA_SERVER_ENABLED=true npm run dev   # Basic256Sha256
```

Point the `asyncua` client at the generated server cert (under `pkiFolder`),
set `client.set_security(...)` to `Basic256Sha256_SignAndEncrypt`, and supply a
valid username/password (`client.set_user` / `client.set_password`). Anonymous
sessions must be rejected.

### Expected result

- Browse lists every site folder and every tag variable.
- A subscribed monitored item receives a `DataChangeNotification` when the
  corresponding 0xSCADA tag updates, within the **200 ms** budget.
- Anonymous connect succeeds in dev, fails in production.

## Tests

Unit tests (run with `npm test`) live in
`server/protocols/opcua-server/__tests__/`:

- `address-space.test.ts` — mapping, NodeId scheme, ordering, dedup, orphans.
- `security.test.ts` — policy selection per environment, cert path layout.
- `user-auth.test.ts` — password verification + auth flow.
- `config.test.ts` — defaults, validation, endpoint URL.
- `storage-data-source.test.ts` — type inference, caching, subscribe fan-out.
```
