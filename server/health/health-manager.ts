/**
 * [12.8] Service Health & Readiness
 * 
 * Aggregates health from all services, provides /healthz and /readyz endpoints,
 * dependency graph checking, startup order validation.
 */

import { Router, Request, Response } from 'express';

// --- Types ---

export type ServiceStatus = 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'unknown';

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  latencyMs?: number;
  message?: string;
  lastCheck: Date;
  details?: Record<string, unknown>;
}

export interface HealthCheck {
  name: string;
  check: () => Promise<ServiceHealth>;
  required: boolean; // If true, failure = not ready
  dependencies?: string[];
}

export interface OverallHealth {
  status: ServiceStatus;
  uptime: number;
  timestamp: string;
  services: ServiceHealth[];
}

// --- Health Manager ---

export class HealthManager {
  private checks = new Map<string, HealthCheck>();
  private cache = new Map<string, ServiceHealth>();
  private startTime = Date.now();
  private checkInterval?: ReturnType<typeof setInterval>;

  constructor(private cacheTtlMs = 10000) {}

  /** Register a health check */
  register(check: HealthCheck): void {
    this.checks.set(check.name, check);
  }

  /** Register a simple check from a function */
  registerSimple(name: string, fn: () => Promise<boolean>, required = true): void {
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
            latencyMs: Date.now() - start,
            lastCheck: new Date(),
          };
        } catch (err: any) {
          return {
            name,
            status: 'unhealthy',
            latencyMs: Date.now() - start,
            message: err.message,
            lastCheck: new Date(),
          };
        }
      },
    });
  }

  /** Run all health checks */
  async checkAll(): Promise<OverallHealth> {
    const results: ServiceHealth[] = [];

    // Respect dependency order
    const ordered = this.topologicalSort();

    for (const name of ordered) {
      const check = this.checks.get(name)!;
      const cached = this.cache.get(name);

      if (cached && Date.now() - cached.lastCheck.getTime() < this.cacheTtlMs) {
        results.push(cached);
        continue;
      }

      try {
        const result = await Promise.race([
          check.check(),
          new Promise<ServiceHealth>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), 5000)
          ),
        ]);
        this.cache.set(name, result);
        results.push(result);
      } catch (err: any) {
        const result: ServiceHealth = {
          name,
          status: 'unhealthy',
          message: err.message,
          lastCheck: new Date(),
        };
        this.cache.set(name, result);
        results.push(result);
      }
    }

    const hasUnhealthy = results.some(
      (r) => r.status === 'unhealthy' && this.checks.get(r.name)?.required
    );
    const hasDegraded = results.some((r) => r.status === 'degraded' || r.status === 'unhealthy');

    return {
      status: hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy',
      uptime: Date.now() - this.startTime,
      timestamp: new Date().toISOString(),
      services: results,
    };
  }

  /** Check if all required services are ready */
  async isReady(): Promise<boolean> {
    const health = await this.checkAll();
    return health.status !== 'unhealthy';
  }

  /** Check if the process is alive (liveness) */
  isAlive(): boolean {
    return true; // If we can respond, we're alive
  }

  /** Start periodic health checking */
  startPeriodicCheck(intervalMs = 30000): void {
    this.checkInterval = setInterval(async () => {
      const health = await this.checkAll();
      if (health.status === 'unhealthy') {
        console.error('[health] System unhealthy:', health.services.filter((s) => s.status === 'unhealthy'));
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  /** Topological sort of checks by dependencies */
  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const check = this.checks.get(name);
      if (check?.dependencies) {
        for (const dep of check.dependencies) {
          if (this.checks.has(dep)) visit(dep);
        }
      }
      result.push(name);
    };

    for (const name of this.checks.keys()) visit(name);
    return result;
  }

  /** Create Express router with /healthz and /readyz endpoints */
  createRouter(): Router {
    const router = Router();

    // Liveness probe - just checks process is alive
    router.get('/healthz', (_req: Request, res: Response) => {
      if (this.isAlive()) {
        res.status(200).json({ status: 'alive', uptime: Date.now() - this.startTime });
      } else {
        res.status(503).json({ status: 'dead' });
      }
    });

    // Readiness probe - checks all required dependencies
    router.get('/readyz', async (_req: Request, res: Response) => {
      const health = await this.checkAll();
      const statusCode = health.status === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json(health);
    });

    // Detailed health - full service breakdown
    router.get('/health', async (_req: Request, res: Response) => {
      const health = await this.checkAll();
      res.status(200).json(health);
    });

    return router;
  }
}

// --- Common Health Checks ---

export function createDatabaseCheck(queryFn: () => Promise<unknown>): HealthCheck {
  return {
    name: 'database',
    required: true,
    check: async () => {
      const start = Date.now();
      try {
        await queryFn();
        return { name: 'database', status: 'healthy', latencyMs: Date.now() - start, lastCheck: new Date() };
      } catch (err: any) {
        return { name: 'database', status: 'unhealthy', latencyMs: Date.now() - start, message: err.message, lastCheck: new Date() };
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
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
          signal: AbortSignal.timeout(3000),
        });
        const ok = res.ok;
        return { name: 'blockchain', status: ok ? 'healthy' : 'degraded', latencyMs: Date.now() - start, lastCheck: new Date() };
      } catch (err: any) {
        return { name: 'blockchain', status: 'unhealthy', latencyMs: Date.now() - start, message: err.message, lastCheck: new Date() };
      }
    },
  };
}

export function createGatewayCheck(checkFn: () => boolean): HealthCheck {
  return {
    name: 'gateway',
    required: false,
    check: async () => ({
      name: 'gateway',
      status: checkFn() ? 'healthy' : 'degraded',
      lastCheck: new Date(),
    }),
  };
}

export default HealthManager;
