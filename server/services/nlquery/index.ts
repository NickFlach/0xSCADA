/**
 * NL Query Service
 * ADR-0013 [13.5] (docs/decisions/ADR-0013-autonomous-agent-architecture.md);
 * route contract in docs/adr/ADR-0027-nl-query-read-scope-and-bounds.md.
 * Issue #216.
 *
 * Read-only over process data: this service answers questions from the
 * historian, the live tag stream, and the alarm-correlation engine. It holds
 * no process state of its own and writes nothing anywhere.
 *
 * The only state it keeps is a bounded, process-local ring buffer of recent
 * query results (MAX_HISTORY_ENTRIES). That history is deliberately NOT
 * persisted — see ADR-0027 §"History is process-local". The API response and
 * the docs both say so explicitly, so an operator is never left assuming a
 * durable audit trail exists here. Control-plane audit lives in `audit_logs`
 * and is unaffected: this surface performs no mutation to audit.
 */

export * from './limits';
export * from './parser';
export * from './resolver';
export * from './engine';
export * from './data-port';

import type { NLQueryDataPort } from '@shared/types/nl-query';
import { NLQueryEngine } from './engine';
import { ProcessDataPort } from './data-port';

export interface NLQueryServiceOptions {
  /** Injectable for tests; production uses the real {@link ProcessDataPort}. */
  dataPort?: NLQueryDataPort;
}

export class NLQueryService {
  readonly engine: NLQueryEngine;

  private initialized = false;

  constructor(options: NLQueryServiceOptions = {}) {
    this.engine = new NLQueryEngine({
      dataPort: options.dataPort ?? new ProcessDataPort(),
    });
  }

  /**
   * No timers, sockets, or subscriptions to start: the port pulls from the
   * historian and the tag stream at query time rather than maintaining a
   * shadow copy of process data.
   */
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    message: string;
    historyPersistence: 'process-local';
  }> {
    return {
      healthy: this.initialized,
      message: this.initialized
        ? 'NL query running: regex intent grammar, read-only over historian, '
          + 'live tag stream, and alarm correlation'
        : 'NL query service not initialized',
      historyPersistence: 'process-local',
    };
  }
}

export const nlQueryService = new NLQueryService();
