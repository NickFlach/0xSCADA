# Enabling PREEMPT_RT for the Tick-Aware Scheduler

The 0xSCADA scheduler can pin an explicitly identified, dedicated control
process to real-time scheduling (`SCHED_FIFO`) so that ticks meet a
deterministic budget. It never elevates the Express process implicitly. The
real-time path also requires a kernel built with **PREEMPT_RT** (the
fully-preemptible real-time patch set, mainlined as of Linux 6.12).

**Real-time scheduling is off by default.** Three independent conditions must
all hold before a single privileged call is made:

1. `OXSCADA_RT_ENABLED=true` is set (explicit operator opt-in), **and**
2. a composition root calls `applyScheduler()` with the PID of a *separate*
   control process, **and**
3. the host is PREEMPT_RT with `chrt(1)` available.

If any of those is missing — or if any `OXSCADA_RT_*` value is malformed — the
scheduler stays in `fallback`, skips the privileged call entirely, logs one
warning, and reports the held posture in `/health`.

> **Safety note.** Nothing applies scheduling as an import side effect.
> `SCHED_FIFO` is starvation-capable: pinning the process that serves
> Express/WebSocket would let a hot loop starve the rest of the box. The
> scheduler refuses `pid === process.pid` outright, so an in-process control
> loop can never elevate the API server. As long as the control loop shares the
> API server's process (the current deployment shape) `fallback` is the correct
> and expected result, and `/health` says so.

This document explains how to put a target host into `realtime` mode.

---

## TL;DR

```bash
# 1. Boot a PREEMPT_RT kernel (see per-distro instructions below).
uname -v | grep -q PREEMPT_RT && echo "RT kernel ✓" || echo "stock kernel ✗"

# 2. Run the control loop in a process separate from the API server.
# The composition root must retain its PID and call:
# applyScheduler({ kind: "dedicated-control-process", pid: controlPid })

# 3. Confirm chrt(1) is present (util-linux). The scheduler shells out to it.
command -v chrt

# 4. Explicitly opt in, then grant only the dedicated process RT capability.
export OXSCADA_RT_ENABLED=true

# 5. Verify. Until a dedicated control-process composition root exists,
# fallback is the expected, honest result.
curl -s localhost:5000/api/health | jq '.services[] | select(.name=="scheduler")'
# → status:"healthy", details.schedulingMode:"fallback", details.applied:false
```

---

## How the scheduler decides

`server/blueprint/scheduler.ts` runs capability detection in this order:

1. **Platform** — not Linux ⇒ always `fallback`.
2. **`/sys/kernel/realtime`** — if it reads `1`, the kernel is authoritatively
   PREEMPT_RT.
3. **`uname`** — version/release string contains `PREEMPT_RT` (or a legacy
   `-rtN` tag).
4. **`/sys/kernel/debug/sched/preempt`** — active preemption model is `(rt)`.

Detection only runs **after** the opt-in check passes: an opted-out or
misconfigured deployment does not even read `/sys`. If any of (2)–(4) is
positive, `chrt(1)` is available, explicit opt-in is set, and the caller supplies
a valid PID different from the calling process, the scheduler applies
`SCHED_FIFO` to that dedicated process at the configured priority (default
**50**). Missing or malformed configuration, a missing dedicated target, the
calling process's own PID, or an apply failure all produce a safe fallback
instead of crashing or elevating the control plane.

`chrt -p <pid>` changes the policy of a whole process. A future native binding
may target an individual control thread, but the current contract is
intentionally limited to a separate process.

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `OXSCADA_RT_ENABLED` | unset (`fallback`) | `true`/`1` opts in; a dedicated process PID is still required. Any other value is treated as *disabled* and reported. |
| `OXSCADA_RT_PRIORITY` | `50` | SCHED_FIFO priority, integer 1–99 (higher = more urgent). |
| `OXSCADA_RT_POLICY` | `SCHED_FIFO` | `SCHED_FIFO`, `SCHED_RR`, or `SCHED_OTHER`. |

Parsing is strict on purpose: `OXSCADA_RT_PRIORITY` must be a plain decimal
integer inside `[1, 99]`. Empty, non-numeric, fractional, out-of-range,
exponent (`1e2`) and hex (`0x40`) values are all **rejected** rather than
silently coerced into a plausible-looking priority. A rejected value is logged
once with a clear message and the process continues under normal scheduling —
it never aborts startup. The same holds for an unknown `OXSCADA_RT_POLICY` or a
non-boolean `OXSCADA_RT_ENABLED`.

Priority **50** matches `CONFIG_OXSCADA_RT_PRIORITY` in `kernel/Kconfig.oxscada`
and deliberately leaves headroom below kernel threads (e.g. `ksoftirqd`,
network IRQ threads) that typically run at 80–99.

### Where scheduling gets applied

`server/blueprint/scheduler.ts` exposes exactly one entry point that can make a
privileged call:

```ts
import { applyScheduler } from "./server/blueprint";

// Only from a composition root that owns a SEPARATE control process:
const status = applyScheduler({ kind: "dedicated-control-process", pid: controlPid });
if (status.mode !== "realtime") log.warn(status.error);
```

`BlueprintTickLoop` (`server/blueprint/tick-loop.ts`) accepts the same
target as an option and forwards it at `start()`. It does **not** default to the
process-wide scheduler: the instance is a required option, so a loop can never
apply a scheduling decision to the shared singleton by accident (#622). Its
`TickFn` seam is what the deterministic runtime from #457 plugs into:

```ts
import { BlueprintTickLoop, getScheduler } from "./server/blueprint";

const loop = new BlueprintTickLoop({
  blueprintId: bp.id,
  periodMs: 10,
  // Explicit: pass getScheduler() for the process-wide instance, or your own
  // TickScheduler when the control process owns its configuration.
  scheduler: getScheduler(),
});
loop.setTickFn(() => runtime.tickFast());
loop.start();
```

Not to be confused with `BlueprintControlLoop` (`server/blueprint/control-loop.ts`,
#457): that is the gated production *host* composed into `server/index.ts`, which
loads a definition from disk and arms a plain `setInterval` inside the API server
process. It deliberately does not take a scheduler target — the API process must
never be pinned to `SCHED_FIFO`. `BlueprintTickLoop` is the timing/telemetry
wrapper a future dedicated control process would use instead.

No module — including `server/health` — applies scheduling on import.

---

## Per-distribution: installing a PREEMPT_RT kernel

### Debian / Ubuntu

Recent Debian (12+) and Ubuntu (24.04+) ship RT-enabled kernels:

```bash
# Debian 12+: the "rt" flavour from the standard archive.
sudo apt-get update
sudo apt-get install linux-image-rt-amd64

# Ubuntu (Ubuntu Pro real-time kernel):
sudo pro attach <token>
sudo pro enable realtime-kernel
```

Reboot, then verify:

```bash
uname -v          # expect: "... SMP PREEMPT_RT ..."
cat /sys/kernel/realtime 2>/dev/null   # expect: 1 (on kernels that export it)
```

### RHEL / Rocky / AlmaLinux

Use the Real Time variant (CodeReady Builder / the `rt` repo):

```bash
sudo subscription-manager repos --enable rhel-9-for-x86_64-rt-rpms   # RHEL
sudo dnf groupinstall RT
sudo grub2-set-default 0   # ensure the kernel-rt entry boots
sudo reboot
```

`tuned-profiles-realtime` + the `realtime` tuned profile is recommended:

```bash
sudo dnf install tuned-profiles-realtime
sudo tuned-adm profile realtime
```

### Building from source (any distro)

```bash
# Mainline >= 6.12 has PREEMPT_RT in-tree. For older trees, apply the patch:
#   https://wiki.linuxfoundation.org/realtime/start
make menuconfig
#   General setup → Preemption Model → "Fully Preemptible Kernel (Real-Time)"
#   (CONFIG_PREEMPT_RT=y)
make -j"$(nproc)" && sudo make modules_install install
sudo reboot
```

`kernel/Kconfig.oxscada` documents the matching 0xSCADA kernel options
(`CONFIG_OXSCADA_RT`, `CONFIG_OXSCADA_RT_PRIORITY`) for the in-tree driver path.

---

## Granting real-time scheduling rights (no runtime root)

`SCHED_FIFO` requires `CAP_SYS_NICE` and a sufficient `RLIMIT_RTPRIO`. Grant
those only to the future dedicated control-process unit, not the API server:

```ini
# /etc/systemd/system/oxscada-control.service
[Service]
ExecStart=/usr/bin/node /opt/oxscada/dist/control-process.js
# Allow the service to set RT priorities up to 99 without root.
AmbientCapabilities=CAP_SYS_NICE
LimitRTPRIO=99
# Pin to isolated/housekeeping-free CPUs for the lowest jitter (optional).
# CPUAffinity=2 3
Environment=OXSCADA_RT_PRIORITY=50
Environment=OXSCADA_RT_ENABLED=true
```

`dist/control-process.js` does **not exist yet** — it is the composition root
that would own a dedicated control process, call `applyScheduler()` with its own
child/worker PID, and drive `BlueprintTickLoop`. Do not deploy this unit
until that executable and its verified field-I/O binding exist. Until then the
scheduler is a mechanism with no production caller and `/health` correctly
reports `fallback`.

```bash
sudo systemctl daemon-reload
sudo systemctl restart oxscada-control
```

For non-systemd hosts, grant rtprio via `/etc/security/limits.d/`:

```
@oxscada   -   rtprio   99
```

### Recommended host tuning for low jitter

These are not required for `realtime` mode but materially reduce tick jitter:

- **CPU isolation:** `isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3` on the kernel
  cmdline, then pin the service to the isolated CPUs.
- **Disable deep C-states:** boot with `intel_idle.max_cstate=1 processor.max_cstate=1`.
- **Disable SMT** if determinism matters more than throughput.
- **`tuned-adm profile realtime`** (RHEL) bundles most of the above.

---

## Verifying the result

### From the application

```bash
curl -s localhost:5000/api/health | jq '.services[] | select(.name=="scheduler").details'
# realtime:
#   { "schedulingMode": "realtime", "policy": "SCHED_FIFO", "priority": 50,
#     "applied": true,  "requested": true,  "realtimeKernel": true }
# fallback:
#   { "schedulingMode": "fallback", "policy": "SCHED_OTHER", "priority": 0,
#     "applied": false, "requested": false, "realtimeKernel": false }
```

`applied` is the ground truth — it is `true` only when the privileged call
actually succeeded. `requested` distinguishes "we never asked" (opt-in absent or
config rejected) from "we asked and it failed", and `realtimeKernel` reports the
host independently of whether we got the policy. The check is registered as
non-required, so a `fallback` posture never marks the node not-ready.

### From the OS

```bash
# Confirm the policy is applied only to the dedicated control process.
CONTROL_PID="$(pgrep -f 'control-process')"
ps -L -o pid,tid,cls,rtprio,comm -p "${CONTROL_PID}"
# cls "FF" = SCHED_FIFO; rtprio shows the priority.

chrt -p "${CONTROL_PID}"
# → "current scheduling policy: SCHED_FIFO" / "current scheduling priority: 50"
```

### Tick telemetry (`/metrics`)

`BlueprintTickLoop` publishes these on every tick, in `realtime` **and** in
`fallback` mode, so you can watch jitter on a stock kernel too. They are
appended to the same `/api/metrics` scrape as the `scada_`-prefixed metrics.

Note that the series only exist once something actually drives a control loop —
until the deterministic runtime from #457 is wired into a loop in production,
these metrics are present in the exposition but carry no samples:

| Metric | Type | Meaning |
| --- | --- | --- |
| `blueprint_tick_jitter_ns` | gauge | Most-recent deviation of the actual tick period from target (ns). |
| `blueprint_tick_missed_deadlines_total` | counter | Ticks whose execution exceeded the deadline budget. |
| `blueprint_tick_wcet_ns` | gauge | Worst-case tick execution time in the rolling window (ns). |
| `oxscada_blueprint_tick_duration_seconds` | histogram | Distribution of tick execution durations (s). |

Example alerting rule:

```yaml
- alert: BlueprintMissingDeadlines
  expr: rate(blueprint_tick_missed_deadlines_total[5m]) > 0
  for: 2m
  labels: { severity: high }
  annotations:
    summary: "Blueprint {{ $labels.blueprint }} is missing tick deadlines"
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `schedulingMode: fallback` with a held/target message | Opt-in or dedicated process PID is absent | Expected until the production composition root is wired; never pass the API server PID. |
| Startup warning: `OXSCADA_RT_PRIORITY='…' is not an integer` / `outside the valid SCHED_FIFO range` | Malformed env value | Set a plain decimal integer in `[1, 99]`. The server keeps running under normal scheduling — this never aborts startup. |
| Startup warning: `OXSCADA_RT_ENABLED='…' is not a boolean` | Typo in the opt-in flag | Use `true` or `1`; anything else is treated as disabled. |
| `schedulingMode: fallback` on an RT kernel | apply failed (no `CAP_SYS_NICE` / `RLIMIT_RTPRIO`) | Grant capability via the systemd unit above; check the startup warning. |
| Startup warning: "no chrt(1) available" | `util-linux` not installed | `apt install util-linux` / `dnf install util-linux`. |
| High `blueprint_tick_jitter_ns` despite `realtime` | competing kernel threads / power management | Isolate CPUs, disable C-states, run `tuned-adm profile realtime`. |
| Warning appears repeatedly | _should not happen_ — the scheduler warns once | File a bug; the single-warning guard is in `TickScheduler.warnOnce`. |
