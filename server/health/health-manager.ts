/**
 * Health Manager — Service health check orchestration
 *
 * Provides liveness/readiness probes, dependency-ordered health checks,
 * caching, and Express router for /healthz, /readyz, /health endpoints.
 */

import { Router, type Request, type Response } from 'express';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ServiceCheckResult {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  lastCheck: Date;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  services: ServiceCheckResult[];
  healthy: boolean;
  components: Record<string, { status: string; healthy: boolean; latencyMs?: number }>;
}

export interface HealthCheck {
  name: string;
  required?: boolean;
  dependencies?: string[];
  check: () => Promise<ServiceCheckResult>;
}

type CheckCompleteListener = (result: HealthCheckResult) => void;

// ── Check Factories ──────────────────────────────────────────────────────────

export function createDatabaseCheck(
  healthFn: () => Promise<{ connected: boolean; latencyMs?: number }>,
): HealthCheck {
  return {
    name: 'database',
    required: true,
    check: async () => {
      const start = Date.now();
      try {
        const h = await healthFn();
        return {
          name: 'database',
          status: h.connected ? 'healthy' : 'unhealthy',
          lastCheck: new Date(),
          latencyMs: h.latencyMs ?? Date.now() - start,
        };
      } catch (err) {
        return {
          name: 'database',
          status: 'unhealthy',
          lastCheck: new Date(),
          message: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - start,
        };
      }
    },
  };
}

export function createBlockchainCheck(rpcUrl: string): HealthCheck {
  return {
    name: 'blockchain',
    required: false,
    dependencies: ['database'],
    check: async () => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'net_version', params: [] }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        return {
          name: 'blockchain',
          status: resp.ok ? 'healthy' : 'unhealthy',
          lastCheck: new Date(),
          latencyMs: Date.now() - start,
        };
      } catch {
        return {
          name: 'blockchain',
          status: 'unhealthy',
          lastCheck: new Date(),
          message: `Cannot reach ${rpcUrl}`,
          latencyMs: Date.now() - start,
        };
      }
    },
  };
}

export function createGatewayCheck(isEnabledFn: () => boolean): HealthCheck {
  return {
    name: 'gateway',
    required: false,
    check: async () => ({
      name: 'gateway',
      status: isEnabledFn() ? 'healthy' : 'unhealthy',
      lastCheck: new Date(),
    }),
  };
}

// ── HealthManager ────────────────────────────────────────────────────────────

export class HealthManager {
  private checks: HealthCheck[] = [];
  private cacheTtlMs: number;
  private cachedResult: HealthCheckResult | null = null;
  private cachedAt = 0;
  private periodicTimer?: ReturnType<typeof setInterval>;
  private listeners: CheckCompleteListener[] = [];
  private startTime = Date.now();

  constructor(cacheTtlMs = 10_000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Register a full health check */
  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  /** Convenience: register a simple boolean check */
  registerSimple(
    name: string,
    fn: () => Promise<boolean>,
    required = true,
  ): void {
    this.register({
      name,
      required,
      check: async () => {
        const start = Date.now();
        try {
          const ok = await fn();
          return {
            name,
            status: ok ? 'healthy' : 'unhealthy',
            lastCheck: new Date(),
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          return {
            name,
            status: 'unhealthy',
            lastCheck: new Date(),
            message: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - start,
          };
        }
      },
    });
  }

  /** Subscribe to check-complete events (used by Prometheus integration) */
  onCheckComplete(listener: CheckCompleteListener): void {
    this.listeners.push(listener);
  }

  /** Run all checks respecting dependency order */
  async checkAll(): Promise<HealthCheckResult> {
    const now = Date.now();
    if (this.cachedResult && now - this.cachedAt < this.cacheTtlMs) {
      return this.cachedResult;
    }

    const ordered = this.topologicalSort();
    const services: ServiceCheckResult[] = [];
    const completed = new Set<string>();

    for (const check of ordered) {
      // Skip if dependency failed
      if (check.dependencies?.some(d => !completed.has(d))) {
        services.push({
          name: check.name,
          status: 'unhealthy',
          lastCheck: new Date(),
          message: 'Skipped: dependency unhealthy',
        });
        continue;
      }

      try {
        const result = await Promise.race([
          check.check(),
          new Promise<ServiceCheckResult>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 10_000),
          ),
        ]);
        services.push(result);
        if (result.status === 'healthy') completed.add(check.name);
      } catch (err) {
        services.push({
          name: check.name,
          status: 'unhealthy',
          lastCheck: new Date(),
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Determine overall status
    const requiredNames = new Set(this.checks.filter(c => c.required !== false).map(c => c.name));
    const requiredUnhealthy = services.some(s => requiredNames.has(s.name) && s.status === 'unhealthy');
    const anyUnhealthy = services.some(s => s.status === 'unhealthy');
    const anyDegraded = services.some(s => s.status === 'degraded');

    let status: 'healthy' | 'unhealthy' | 'degraded';
    if (requiredUnhealthy) status = 'unhealthy';
    else if (anyUnhealthy || anyDegraded) status = 'degraded';
    else status = 'healthy';

    const components: Record<string, { status: string; healthy: boolean; latencyMs?: number }> = {};
    for (const s of services) {
      components[s.name] = {
        status: s.status === 'healthy' ? 'up' : 'down',
        healthy: s.status === 'healthy',
        latencyMs: s.latencyMs,
      };
    }

    const result: HealthCheckResult = {
      status,
      timestamp: new Date().toISOString(),
      uptime: (Date.now() - this.startTime) / 1000,
      services,
      healthy: status !== 'unhealthy',
      components,
    };

    this.cachedResult = result;
    this.cachedAt = now;

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(result); } catch { /* ignore */ }
    }

    return result;
  }

  /** Kubernetes-style readiness probe */
  async isReady(): Promise<boolean> {
    const result = await this.checkAll();
    return result.healthy;
  }

  /** Kubernetes-style liveness probe (always true unless process is dead) */
  isAlive(): boolean {
    return true;
  }

  /** Start periodic background health checks */
  startPeriodicCheck(intervalMs: number): void {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(() => {
      this.checkAll().catch(() => {});
    }, intervalMs);
  }

  /** Create Express router with /healthz, /readyz, /health */
  createRouter(): Router {
    const router = Router();

    router.get('/healthz', (_req: Request, res: Response) => {
      res.status(this.isAlive() ? 200 : 503).json({ status: this.isAlive() ? 'alive' : 'dead' });
    });

    router.get('/readyz', async (_req: Request, res: Response) => {
      try {
        const ready = await this.isReady();
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready' });
      } catch {
        res.status(503).json({ status: 'not ready' });
      }
    });

    router.get('/health', async (_req: Request, res: Response) => {
      try {
        const result = await this.checkAll();
        res.status(result.healthy ? 200 : 503).json(result);
      } catch {
        res.status(503).json({ status: 'unhealthy' });
      }
    });

    return router;
  }

  /** Topological sort respecting dependencies */
  private topologicalSort(): HealthCheck[] {
    const byName = new Map(this.checks.map(c => [c.name, c]));
    const visited = new Set<string>();
    const result: HealthCheck[] = [];

    const visit = (check: HealthCheck) => {
      if (visited.has(check.name)) return;
      visited.add(check.name);
      for (const dep of check.dependencies ?? []) {
        const depCheck = byName.get(dep);
        if (depCheck) visit(depCheck);
      }
      result.push(check);
    };

    for (const check of this.checks) visit(check);
    return result;
  }
}
