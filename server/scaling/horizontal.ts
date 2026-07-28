import { hash64 } from "./hash";

export interface RingNode {
  id: string;
  virtualNodes?: number;
}

export interface AssignmentChange {
  key: string;
  from?: string;
  to: string;
}

interface RingPoint {
  hash: bigint;
  nodeId: string;
  replica: number;
}

/**
 * Consistent-hash ring used to assign tag namespaces to gateways. Adding or
 * removing a node only moves keys whose clockwise owner changed.
 */
export class ConsistentHashRing {
  private readonly nodes = new Map<string, Required<RingNode>>();
  private points: RingPoint[] = [];

  constructor(
    nodes: readonly RingNode[] = [],
    private readonly defaultVirtualNodes = 128,
  ) {
    if (!Number.isInteger(defaultVirtualNodes) || defaultVirtualNodes < 1) {
      throw new Error("defaultVirtualNodes must be a positive integer");
    }
    for (const node of nodes) {
      this.add(node);
    }
  }

  add(node: RingNode): void {
    if (!node.id.trim()) {
      throw new Error("ring node id cannot be empty");
    }
    const virtualNodes = node.virtualNodes ?? this.defaultVirtualNodes;
    if (!Number.isInteger(virtualNodes) || virtualNodes < 1) {
      throw new Error(`virtualNodes for ${node.id} must be a positive integer`);
    }
    this.nodes.set(node.id, { id: node.id, virtualNodes });
    this.rebuild();
  }

  remove(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);
    if (removed) {
      this.rebuild();
    }
    return removed;
  }

  nodeIds(): string[] {
    return [...this.nodes.keys()].sort();
  }

  owner(key: string): string {
    if (this.points.length === 0) {
      throw new Error("cannot assign a key without gateway nodes");
    }
    const target = hash64(key);
    let low = 0;
    let high = this.points.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.points[middle].hash < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return this.points[low === this.points.length ? 0 : low].nodeId;
  }

  assign(keys: readonly string[]): Map<string, string> {
    return new Map(keys.map((key) => [key, this.owner(key)]));
  }

  rebalance(
    keys: readonly string[],
    previous: ReadonlyMap<string, string>,
  ): AssignmentChange[] {
    const changes: AssignmentChange[] = [];
    for (const key of keys) {
      const to = this.owner(key);
      const from = previous.get(key);
      if (from !== to) {
        changes.push(from === undefined ? { key, to } : { key, from, to });
      }
    }
    return changes.sort((left, right) => left.key.localeCompare(right.key));
  }

  private rebuild(): void {
    this.points = [];
    for (const node of this.nodes.values()) {
      for (let replica = 0; replica < node.virtualNodes; replica += 1) {
        this.points.push({
          hash: hash64(`${node.id}\0${replica}`),
          nodeId: node.id,
          replica,
        });
      }
    }
    this.points.sort(
      (left, right) =>
        Number(left.hash - right.hash) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.replica - right.replica,
    );
  }
}

export type LoadBalancingStrategy =
  | "round-robin"
  | "weighted"
  | "least-connections";

export interface LoadBalancedTarget {
  id: string;
  weight?: number;
  healthy?: boolean;
  activeConnections?: number;
}

export interface TargetLease {
  target: Readonly<Required<LoadBalancedTarget>>;
  release(): void;
}

interface TargetState extends Required<LoadBalancedTarget> {
  currentWeight: number;
}

/**
 * Server-side selector. `acquire` increments connection count and returns an
 * idempotent lease so least-connections remains correct across failures.
 */
export class ServerLoadBalancer {
  private readonly targets = new Map<string, TargetState>();
  private roundRobinIndex = 0;

  constructor(
    targets: readonly LoadBalancedTarget[],
    private strategy: LoadBalancingStrategy = "round-robin",
  ) {
    for (const target of targets) {
      this.upsert(target);
    }
  }

  setStrategy(strategy: LoadBalancingStrategy): void {
    this.strategy = strategy;
  }

  upsert(target: LoadBalancedTarget): void {
    const weight = target.weight ?? 1;
    if (!target.id.trim()) {
      throw new Error("load-balancer target id cannot be empty");
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`weight for ${target.id} must be greater than zero`);
    }
    const previous = this.targets.get(target.id);
    this.targets.set(target.id, {
      id: target.id,
      weight,
      healthy: target.healthy ?? previous?.healthy ?? true,
      activeConnections:
        target.activeConnections ?? previous?.activeConnections ?? 0,
      currentWeight: previous?.currentWeight ?? 0,
    });
  }

  remove(targetId: string): boolean {
    return this.targets.delete(targetId);
  }

  setHealthy(targetId: string, healthy: boolean): void {
    this.required(targetId).healthy = healthy;
  }

  snapshot(): ReadonlyArray<Readonly<Required<LoadBalancedTarget>>> {
    return [...this.targets.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ currentWeight: _ignored, ...target }) => ({ ...target }));
  }

  acquire(): TargetLease {
    const target = this.select();
    target.activeConnections += 1;
    let released = false;
    return {
      target: this.publicTarget(target),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        target.activeConnections = Math.max(0, target.activeConnections - 1);
      },
    };
  }

  private select(): TargetState {
    const healthy = [...this.targets.values()]
      .filter((target) => target.healthy)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (healthy.length === 0) {
      throw new Error("no healthy load-balancer targets");
    }

    if (this.strategy === "least-connections") {
      return healthy.reduce((best, candidate) => {
        const bestLoad = best.activeConnections / best.weight;
        const candidateLoad = candidate.activeConnections / candidate.weight;
        return candidateLoad < bestLoad ? candidate : best;
      });
    }

    if (this.strategy === "weighted") {
      const totalWeight = healthy.reduce(
        (total, target) => total + target.weight,
        0,
      );
      for (const target of healthy) {
        target.currentWeight += target.weight;
      }
      const selected = healthy.reduce((best, candidate) =>
        candidate.currentWeight > best.currentWeight ? candidate : best,
      );
      selected.currentWeight -= totalWeight;
      return selected;
    }

    const selected = healthy[this.roundRobinIndex % healthy.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % healthy.length;
    return selected;
  }

  private required(targetId: string): TargetState {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(`unknown load-balancer target: ${targetId}`);
    }
    return target;
  }

  private publicTarget(target: TargetState): Required<LoadBalancedTarget> {
    return {
      id: target.id,
      weight: target.weight,
      healthy: target.healthy,
      activeConnections: target.activeConnections,
    };
  }
}

export interface HistorianPoint<T = unknown> {
  tag: string;
  timestamp: Date;
  value: T;
  quality?: string;
}

export interface HistorianQuery {
  from: Date;
  to: Date;
  tags?: readonly string[];
}

export interface HistorianPartition {
  id: string;
  write(point: HistorianPoint): Promise<void>;
  query(query: HistorianQuery): Promise<readonly HistorianPoint[]>;
}

export interface FederatedHistorianResult {
  points: HistorianPoint[];
  failures: Array<{ partitionId: string; error: string }>;
}

/**
 * Partitions historian writes by tag hash and federates reads across only the
 * shards that can contain the requested tags. Partial failures are explicit.
 */
export class PartitionedHistorian {
  private readonly partitions: readonly HistorianPartition[];

  constructor(partitions: readonly HistorianPartition[]) {
    if (partitions.length === 0) {
      throw new Error("at least one historian partition is required");
    }
    const ids = new Set(partitions.map((partition) => partition.id));
    if (ids.size !== partitions.length) {
      throw new Error("historian partition ids must be unique");
    }
    this.partitions = [...partitions].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  route(tag: string): HistorianPartition {
    const index = Number(hash64(tag) % BigInt(this.partitions.length));
    return this.partitions[index];
  }

  async write(point: HistorianPoint): Promise<string> {
    const partition = this.route(point.tag);
    await partition.write(point);
    return partition.id;
  }

  async query(query: HistorianQuery): Promise<FederatedHistorianResult> {
    if (query.to < query.from) {
      throw new Error("historian query end must not precede start");
    }
    const candidates: Array<{
      partition: HistorianPartition;
      query: HistorianQuery;
    }> = [];
    if (query.tags?.length) {
      const grouped = new Map<
        string,
        { partition: HistorianPartition; tags: string[] }
      >();
      for (const tag of [...new Set(query.tags)]) {
        const partition = this.route(tag);
        const group = grouped.get(partition.id) ?? { partition, tags: [] };
        group.tags.push(tag);
        grouped.set(partition.id, group);
      }
      for (const group of [...grouped.values()].sort((left, right) =>
        left.partition.id.localeCompare(right.partition.id),
      )) {
        candidates.push({
          partition: group.partition,
          query: { ...query, tags: group.tags.sort() },
        });
      }
    } else {
      candidates.push(
        ...this.partitions.map((partition) => ({ partition, query })),
      );
    }
    const settled = await Promise.allSettled(
      candidates.map((candidate) =>
        Promise.resolve().then(() =>
          candidate.partition.query(candidate.query),
        ),
      ),
    );
    const points: HistorianPoint[] = [];
    const failures: FederatedHistorianResult["failures"] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        points.push(...result.value);
      } else {
        failures.push({
          partitionId: candidates[index].partition.id,
          error: errorMessage(result.reason),
        });
      }
    });
    points.sort(
      (left, right) =>
        left.timestamp.getTime() - right.timestamp.getTime() ||
        left.tag.localeCompare(right.tag),
    );
    return { points, failures };
  }
}

export interface PartitionedEvent<T = unknown> {
  topic: string;
  key: string;
  payload: T;
}

export type PartitionHandler<T = unknown> = (
  event: PartitionedEvent<T>,
  partition: number,
) => void | Promise<void>;

export interface FanoutReceipt {
  partition: number;
  delivered: number;
  failures: Array<{ subscriberId: string; error: string }>;
}

interface Subscription {
  id: string;
  partitions?: ReadonlySet<number>;
  handler: PartitionHandler;
}

/** In-process reference bus whose transport boundary can be replaced by NATS/Kafka. */
export class PartitionedEventFanout {
  private readonly subscriptions = new Map<string, Map<string, Subscription>>();
  private readonly partitionTails = new Map<string, Promise<void>>();

  constructor(readonly partitionCount: number) {
    if (!Number.isInteger(partitionCount) || partitionCount < 1) {
      throw new Error("partitionCount must be a positive integer");
    }
  }

  partitionFor(key: string): number {
    return Number(hash64(key) % BigInt(this.partitionCount));
  }

  subscribe(
    topic: string,
    subscriberId: string,
    handler: PartitionHandler,
    partitions?: readonly number[],
  ): () => void {
    if (!topic || !subscriberId) {
      throw new Error("topic and subscriberId are required");
    }
    const selected = partitions
      ? new Set(
          partitions.map((partition) => {
            if (
              !Number.isInteger(partition) ||
              partition < 0 ||
              partition >= this.partitionCount
            ) {
              throw new Error(`invalid event partition: ${partition}`);
            }
            return partition;
          }),
        )
      : undefined;
    const byTopic =
      this.subscriptions.get(topic) ?? new Map<string, Subscription>();
    if (byTopic.has(subscriberId)) {
      throw new Error(`duplicate subscriber ${subscriberId} for ${topic}`);
    }
    byTopic.set(subscriberId, {
      id: subscriberId,
      partitions: selected,
      handler,
    });
    this.subscriptions.set(topic, byTopic);
    return () => {
      byTopic.delete(subscriberId);
      if (byTopic.size === 0) {
        this.subscriptions.delete(topic);
      }
    };
  }

  async publish<T>(event: PartitionedEvent<T>): Promise<FanoutReceipt> {
    const partition = this.partitionFor(event.key);
    const orderedKey = `${event.topic}\0${partition}`;
    const previous = this.partitionTails.get(orderedKey) ?? Promise.resolve();
    let receipt!: FanoutReceipt;
    const delivery = previous.then(async () => {
      receipt = await this.deliver(event, partition);
    });
    const tail = delivery.catch(() => undefined);
    this.partitionTails.set(orderedKey, tail);
    await delivery;
    if (this.partitionTails.get(orderedKey) === tail) {
      this.partitionTails.delete(orderedKey);
    }
    return receipt;
  }

  private async deliver<T>(
    event: PartitionedEvent<T>,
    partition: number,
  ): Promise<FanoutReceipt> {
    const subscriptions = [
      ...(this.subscriptions.get(event.topic)?.values() ?? []),
    ]
      .filter(
        (subscription) =>
          !subscription.partitions ||
          subscription.partitions.has(partition),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const results = await Promise.allSettled(
      subscriptions.map((subscription) =>
        Promise.resolve().then(() =>
          subscription.handler(event, partition),
        ),
      ),
    );
    const failures: FanoutReceipt["failures"] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push({
          subscriberId: subscriptions[index].id,
          error: errorMessage(result.reason),
        });
      }
    });
    return {
      partition,
      delivered: subscriptions.length - failures.length,
      failures,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
