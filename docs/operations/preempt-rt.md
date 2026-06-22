# Enabling PREEMPT_RT for the Tick-Aware Scheduler

The 0xSCADA blueprint control loop can pin its control thread to real-time
scheduling (`SCHED_FIFO`) so that ticks meet a deterministic budget. This only
takes effect on a kernel built with **PREEMPT_RT** (the fully-preemptible
real-time patch set, mainlined as of Linux 6.12). On any other kernel — or on
Windows/macOS dev boxes — the server falls back gracefully: it skips the
privileged scheduler call, logs a **single** startup warning, and reports
`schedulingMode: "fallback"` in `/health`.

This document explains how to put a target host into the `realtime` mode.

---

## TL;DR

```bash
# 1. Boot a PREEMPT_RT kernel (see per-distro instructions below).
uname -v | grep -q PREEMPT_RT && echo "RT kernel ✓" || echo "stock kernel ✗"

# 2. Grant the service real-time scheduling capability (no root at runtime).
sudo setcap cap_sys_nice+ep "$(command -v node)"
# …or, preferred: a systemd unit with LimitRTPRIO + AmbientCapabilities (below).

# 3. Confirm chrt(1) is present (util-linux). The scheduler shells out to it.
command -v chrt

# 4. Start the server and verify.
curl -s localhost:5000/health | jq '.services[] | select(.name=="scheduler")'
# → status:"healthy", details.schedulingMode:"realtime", details.policy:"SCHED_FIFO"
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

If any of (2)–(4) is positive **and** `chrt(1)` is available, the scheduler
applies `SCHED_FIFO` to the process at the configured priority (default **50**).
If the kernel is RT-capable but the apply fails (missing `CAP_SYS_NICE` or an
insufficient `RLIMIT_RTPRIO`), it logs one warning and falls back rather than
crashing the control plane.

> **Known limitation (tracked).** `chrt -p <pid>` changes the policy of the
> whole process. Targeting *only* the dedicated control thread requires a
> `worker_thread` calling `sched_setscheduler(SCHED_FIFO, gettid(), …)` via an
> N-API addon. The scheduler isolates this behind the `RtSyscall` seam so the
> addon can be dropped in without touching callers. See the TODO in
> `scheduler.ts`.

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `OXSCADA_RT_PRIORITY` | `50` | SCHED_FIFO priority, 1–99 (higher = more urgent). |
| `OXSCADA_RT_POLICY` | `SCHED_FIFO` | `SCHED_FIFO`, `SCHED_RR`, or `SCHED_OTHER`. |
| `OXSCADA_RT_DISABLE` | unset | `1`/`true` forces `fallback` even on an RT kernel. |

Priority **50** matches `CONFIG_OXSCADA_RT_PRIORITY` in `kernel/Kconfig.oxscada`
and deliberately leaves headroom below kernel threads (e.g. `ksoftirqd`,
network IRQ threads) that typically run at 80–99.

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

`SCHED_FIFO` requires `CAP_SYS_NICE` and a sufficient `RLIMIT_RTPRIO`. Prefer a
systemd unit over `setcap` on the Node binary:

```ini
# /etc/systemd/system/oxscada.service
[Service]
ExecStart=/usr/bin/node /opt/oxscada/dist/server/index.js
# Allow the service to set RT priorities up to 99 without root.
AmbientCapabilities=CAP_SYS_NICE
LimitRTPRIO=99
# Pin to isolated/housekeeping-free CPUs for the lowest jitter (optional).
# CPUAffinity=2 3
Environment=OXSCADA_RT_PRIORITY=50
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart oxscada
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
curl -s localhost:5000/health | jq '.services[] | select(.name=="scheduler").details'
# realtime:
#   { "schedulingMode": "realtime", "policy": "SCHED_FIFO", "priority": 50, "realtimeKernel": true }
# fallback:
#   { "schedulingMode": "fallback", "policy": "SCHED_OTHER", "priority": 0, "realtimeKernel": false }
```

### From the OS

```bash
# Confirm the policy is actually applied to the process/threads.
ps -L -o pid,tid,cls,rtprio,comm -p "$(pgrep -f 'server/index')"
# cls "FF" = SCHED_FIFO; rtprio shows the priority.

chrt -p "$(pgrep -f 'server/index')"
# → "current scheduling policy: SCHED_FIFO" / "current scheduling priority: 50"
```

### Tick telemetry (`/metrics`)

The scheduler emits these to the Prometheus scrape regardless of mode, so you
can watch jitter even while running in `fallback`:

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
| `schedulingMode: fallback` on an RT kernel | apply failed (no `CAP_SYS_NICE` / `RLIMIT_RTPRIO`) | Grant capability via the systemd unit above; check the startup warning. |
| Startup warning: "no chrt(1) available" | `util-linux` not installed | `apt install util-linux` / `dnf install util-linux`. |
| High `blueprint_tick_jitter_ns` despite `realtime` | competing kernel threads / power management | Isolate CPUs, disable C-states, run `tuned-adm profile realtime`. |
| Warning appears repeatedly | _should not happen_ — the scheduler warns once | File a bug; the single-warning guard is in `TickScheduler.warnOnce`. |
