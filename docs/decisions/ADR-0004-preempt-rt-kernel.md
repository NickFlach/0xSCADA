# ADR-0004: PREEMPT_RT Kernel for Real-Time Control

## Status

Accepted

## Date

2024-01-22

## Context

SCADA systems controlling physical processes require **hard real-time guarantees**:

1. **Deterministic latency**: Control loops must execute within bounded time
2. **Priority scheduling**: Critical tasks cannot be preempted by less important ones
3. **Interrupt handling**: Hardware interrupts processed with minimal jitter
4. **Watchdog compliance**: Missing deadlines can trigger safety shutdowns

Standard Linux kernels provide:
- Best-effort scheduling with ~10ms typical latency
- Unbounded worst-case latencies (up to 100ms+)
- Non-preemptible kernel sections

This is unsuitable for control loops requiring <1ms response times.

## Decision

We mandate **Linux PREEMPT_RT** (Real-Time Preemption Patch) for all control plane nodes:

1. **Kernel Configuration**:
   - `CONFIG_PREEMPT_RT=y` (full real-time preemption)
   - `CONFIG_HZ_1000=y` (1ms timer resolution)
   - `CONFIG_NO_HZ_FULL=y` (tickless operation for RT tasks)

2. **Process Priorities**:
   ```
   Priority 99: Safety shutdown handler
   Priority 90: Control loop executor
   Priority 80: Telemetry collector
   Priority 50: Blockchain commitments
   Priority 20: Logging and diagnostics
   ```

3. **CPU Isolation**:
   - Dedicated cores for RT tasks (`isolcpus`, `nohz_full`)
   - IRQ affinity pinning away from RT cores
   - Memory locked with `mlockall()`

4. **Latency Targets**:
   - Worst-case control loop: <500µs
   - 99th percentile: <100µs
   - Interrupt-to-handler: <50µs

## Consequences

### Positive

- **Bounded latency**: Guaranteed worst-case response times
- **Preemptible kernel**: Even kernel code can be preempted
- **Priority inheritance**: Prevents priority inversion
- **Industry standard**: Used in robotics, audio, industrial control

### Negative

- **Throughput reduction**: ~10-15% lower overall throughput
- **Kernel maintenance**: Custom kernel builds required
- **Hardware dependencies**: Not all drivers are RT-compatible
- **Complexity**: Requires careful system configuration

### Neutral

- Mainstream Linux integration (PREEMPT_RT merging into mainline)
- Compatible with standard Linux userspace
- Debugging requires specialized tools (ftrace, cyclictest)

## Alternatives Considered

### Alternative 1: Standard Linux with SCHED_FIFO

Use standard kernel with real-time scheduling classes.

Rejected because: Kernel sections remain non-preemptible, causing unbounded latency spikes.

### Alternative 2: Xenomai/RTAI

Dual-kernel real-time extensions.

Rejected because: Adds complexity of secondary kernel, limited driver ecosystem, and harder debugging.

### Alternative 3: VxWorks/QNX (Commercial RTOS)

Commercial real-time operating systems.

Rejected because: Licensing costs, proprietary ecosystem, and reduced community tooling.

### Alternative 4: Bare-Metal or Microcontroller

Run control loops on dedicated microcontrollers (ARM Cortex-M, etc.).

Rejected because: Increases architectural complexity; PREEMPT_RT provides sufficient guarantees while maintaining Linux flexibility.

## References

- [PREEMPT_RT Wiki](https://wiki.linuxfoundation.org/realtime/start)
- [Real-Time Linux Collaborative Project](https://www.linuxfoundation.org/projects/real-time-linux/)
- [cyclictest Benchmark Tool](https://wiki.linuxfoundation.org/realtime/documentation/howto/tools/cyclictest/start)
- [ADR-0001: Hybrid Architecture](ADR-0001-hybrid-on-off-chain-architecture.md)
