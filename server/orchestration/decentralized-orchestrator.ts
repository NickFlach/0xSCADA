/**
 * Decentralized Orchestration — Peer-to-peer workload orchestration
 *
 * Issue #147 — Decentralized orchestration without central coordinator
 *
 * Implements gossip-based node discovery, Raft-inspired leader election
 * for scheduling, and workload distribution without a central Kubernetes
 * API server. Designed for edge/industrial deployments where a central
 * control plane is a single point of failure.
 */

import { EventEmitter } from "events";
import * as crypto from "crypto";

// =============================================================================
// TYPES
// =============================================================================

export interface NodeInfo {
  id: string;
  address: string;
  port: number;
  capabilities: string[];
  load: number; // 0-1
  lastSeen: number;
  version: string;
  metadata: Record<string, string>;
}

export interface GossipMessage {
  type: "heartbeat" | "join" | "leave" | "workload" | "election" | "vote" | "leader";
  senderId: string;
  timestamp: number;
  ttl: number;
  payload: unknown;
  signature?: string;
}

export interface Workload {
  id: string;
  name: string;
  image: string;
  replicas: number;
  resources: { cpu: number; memoryMb: number };
  constraints: WorkloadConstraint[];
  status: "pending" | "scheduling" | "running" | "failed";
  assignedNodes: string[];
  createdAt: number;
}

export interface WorkloadConstraint {
  type: "capability" | "affinity" | "anti-affinity" | "max-load";
  value: string;
}

export interface ElectionState {
  term: number;
  votedFor: string | null;
  leaderId: string | null;
  state: "follower" | "candidate" | "leader";
  votes: Set<string>;
  electionTimeout: number;
}

export interface OrchestratorConfig {
  nodeId?: string;
  listenAddress: string;
  listenPort: number;
  seedNodes: string[];
  gossipIntervalMs: number;
  heartbeatIntervalMs: number;
  electionTimeoutMinMs: number;
  electionTimeoutMaxMs: number;
  nodeTimeoutMs: number;
  maxGossipFanout: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  listenAddress: "0.0.0.0",
  listenPort: 9400,
  seedNodes: [],
  gossipIntervalMs: 1000,
  heartbeatIntervalMs: 3000,
  electionTimeoutMinMs: 5000,
  electionTimeoutMaxMs: 10000,
  nodeTimeoutMs: 15000,
  maxGossipFanout: 3,
};

// =============================================================================
// GOSSIP PROTOCOL
// =============================================================================

export class GossipProtocol extends EventEmitter {
  private nodes: Map<string, NodeInfo> = new Map();
  private messageLog: Set<string> = new Set();
  private gossipTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: OrchestratorConfig;
  private readonly selfNode: NodeInfo;

  constructor(config: Partial<OrchestratorConfig>, capabilities: string[] = []) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.selfNode = {
      id: this.config.nodeId || crypto.randomUUID(),
      address: this.config.listenAddress,
      port: this.config.listenPort,
      capabilities,
      load: 0,
      lastSeen: Date.now(),
      version: "1.0.0",
      metadata: {},
    };
    this.nodes.set(this.selfNode.id, this.selfNode);
  }

  get nodeId(): string {
    return this.selfNode.id;
  }

  get knownNodes(): NodeInfo[] {
    return Array.from(this.nodes.values());
  }

  get aliveNodes(): NodeInfo[] {
    const cutoff = Date.now() - this.config.nodeTimeoutMs;
    return this.knownNodes.filter((n) => n.lastSeen > cutoff);
  }

  start(): void {
    // Join seed nodes
    for (const seed of this.config.seedNodes) {
      this.sendJoin(seed);
    }

    // Periodic gossip
    this.gossipTimer = setInterval(() => {
      this.gossipRound();
      this.pruneDeadNodes();
    }, this.config.gossipIntervalMs);

    this.emit("started", this.selfNode);
  }

  stop(): void {
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = null;
    }
    this.broadcastMessage({
      type: "leave",
      senderId: this.selfNode.id,
      timestamp: Date.now(),
      ttl: 3,
      payload: { nodeId: this.selfNode.id },
    });
    this.emit("stopped");
  }

  updateLoad(load: number): void {
    this.selfNode.load = Math.max(0, Math.min(1, load));
    this.selfNode.lastSeen = Date.now();
  }

  handleMessage(msg: GossipMessage): void {
    // Dedup
    const msgId = `${msg.senderId}:${msg.timestamp}:${msg.type}`;
    if (this.messageLog.has(msgId)) return;
    this.messageLog.add(msgId);

    // Trim log (keep last 10k)
    if (this.messageLog.size > 10000) {
      const arr = Array.from(this.messageLog);
      this.messageLog = new Set(arr.slice(arr.length - 5000));
    }

    switch (msg.type) {
      case "heartbeat":
        this.handleHeartbeat(msg);
        break;
      case "join":
        this.handleJoin(msg);
        break;
      case "leave":
        this.handleLeave(msg);
        break;
      default:
        this.emit("message", msg);
    }

    // Forward with decremented TTL
    if (msg.ttl > 1) {
      this.forwardMessage({ ...msg, ttl: msg.ttl - 1 });
    }
  }

  private gossipRound(): void {
    this.selfNode.lastSeen = Date.now();
    this.broadcastMessage({
      type: "heartbeat",
      senderId: this.selfNode.id,
      timestamp: Date.now(),
      ttl: 3,
      payload: {
        node: this.selfNode,
        knownNodeIds: Array.from(this.nodes.keys()),
      },
    });
  }

  private handleHeartbeat(msg: GossipMessage): void {
    const payload = msg.payload as { node: NodeInfo; knownNodeIds: string[] };
    this.nodes.set(payload.node.id, { ...payload.node, lastSeen: Date.now() });
    this.emit("nodeUpdated", payload.node);
  }

  private handleJoin(msg: GossipMessage): void {
    const payload = msg.payload as NodeInfo;
    this.nodes.set(payload.id, { ...payload, lastSeen: Date.now() });
    this.emit("nodeJoined", payload);
  }

  private handleLeave(msg: GossipMessage): void {
    const payload = msg.payload as { nodeId: string };
    this.nodes.delete(payload.nodeId);
    this.emit("nodeLeft", payload.nodeId);
  }

  private pruneDeadNodes(): void {
    const cutoff = Date.now() - this.config.nodeTimeoutMs;
    for (const [id, node] of this.nodes) {
      if (id !== this.selfNode.id && node.lastSeen < cutoff) {
        this.nodes.delete(id);
        this.emit("nodeTimeout", id);
      }
    }
  }

  private broadcastMessage(msg: GossipMessage): void {
    this.forwardMessage(msg);
  }

  private forwardMessage(msg: GossipMessage): void {
    // Select random subset of peers (fanout)
    const peers = this.aliveNodes.filter((n) => n.id !== this.selfNode.id);
    const targets = this.randomSample(peers, this.config.maxGossipFanout);
    for (const target of targets) {
      this.emit("send", target, msg);
    }
  }

  private sendJoin(seedAddress: string): void {
    this.emit("sendTo", seedAddress, {
      type: "join",
      senderId: this.selfNode.id,
      timestamp: Date.now(),
      ttl: 5,
      payload: this.selfNode,
    } satisfies GossipMessage);
  }

  private randomSample<T>(arr: T[], n: number): T[] {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
}

// =============================================================================
// LEADER ELECTION (Raft-inspired)
// =============================================================================

export class LeaderElection extends EventEmitter {
  private election: ElectionState;
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly nodeId: string;
  private readonly config: OrchestratorConfig;
  private getAliveNodes: () => NodeInfo[];

  constructor(
    nodeId: string,
    config: Partial<OrchestratorConfig>,
    getAliveNodes: () => NodeInfo[]
  ) {
    super();
    this.nodeId = nodeId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.getAliveNodes = getAliveNodes;
    this.election = {
      term: 0,
      votedFor: null,
      leaderId: null,
      state: "follower",
      votes: new Set(),
      electionTimeout: this.randomElectionTimeout(),
    };
  }

  get isLeader(): boolean {
    return this.election.state === "leader";
  }

  get leaderId(): string | null {
    return this.election.leaderId;
  }

  get currentTerm(): number {
    return this.election.term;
  }

  start(): void {
    this.resetElectionTimer();
  }

  stop(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  handleElectionMessage(msg: GossipMessage): void {
    const payload = msg.payload as { term: number; candidateId?: string; leaderId?: string };

    if (payload.term < this.election.term) return;

    if (payload.term > this.election.term) {
      this.stepDown(payload.term);
    }

    switch (msg.type) {
      case "election":
        this.handleVoteRequest(msg.senderId, payload.term);
        break;
      case "vote":
        this.handleVoteResponse(msg.senderId);
        break;
      case "leader":
        this.election.leaderId = payload.leaderId || msg.senderId;
        this.election.state = "follower";
        this.resetElectionTimer();
        this.emit("leaderElected", this.election.leaderId);
        break;
    }
  }

  private startElection(): void {
    this.election.term++;
    this.election.state = "candidate";
    this.election.votedFor = this.nodeId;
    this.election.votes = new Set([this.nodeId]);

    this.emit("requestVotes", {
      type: "election",
      senderId: this.nodeId,
      timestamp: Date.now(),
      ttl: 3,
      payload: { term: this.election.term, candidateId: this.nodeId },
    } satisfies GossipMessage);

    this.resetElectionTimer();
    this.checkMajority();
  }

  private handleVoteRequest(candidateId: string, term: number): void {
    if (this.election.votedFor === null || this.election.votedFor === candidateId) {
      this.election.votedFor = candidateId;
      this.emit("sendVote", {
        type: "vote",
        senderId: this.nodeId,
        timestamp: Date.now(),
        ttl: 3,
        payload: { term, candidateId },
      } satisfies GossipMessage);
      this.resetElectionTimer();
    }
  }

  private handleVoteResponse(voterId: string): void {
    if (this.election.state !== "candidate") return;
    this.election.votes.add(voterId);
    this.checkMajority();
  }

  private checkMajority(): void {
    const aliveCount = this.getAliveNodes().length;
    const majority = Math.floor(aliveCount / 2) + 1;

    if (this.election.votes.size >= majority) {
      this.becomeLeader();
    }
  }

  private becomeLeader(): void {
    this.election.state = "leader";
    this.election.leaderId = this.nodeId;

    this.emit("becameLeader", this.election.term);
    this.emit("announceLeader", {
      type: "leader",
      senderId: this.nodeId,
      timestamp: Date.now(),
      ttl: 5,
      payload: { term: this.election.term, leaderId: this.nodeId },
    } satisfies GossipMessage);

    // Send periodic heartbeats as leader
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.emit("announceLeader", {
        type: "leader",
        senderId: this.nodeId,
        timestamp: Date.now(),
        ttl: 3,
        payload: { term: this.election.term, leaderId: this.nodeId },
      } satisfies GossipMessage);
    }, this.config.heartbeatIntervalMs);
  }

  private stepDown(newTerm: number): void {
    this.election.term = newTerm;
    this.election.state = "follower";
    this.election.votedFor = null;
    this.election.votes = new Set();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.resetElectionTimer();
  }

  private resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.election.state === "leader") return;

    this.election.electionTimeout = this.randomElectionTimeout();
    this.electionTimer = setTimeout(() => {
      this.startElection();
    }, this.election.electionTimeout);
  }

  private randomElectionTimeout(): number {
    const { electionTimeoutMinMs, electionTimeoutMaxMs } = this.config;
    return electionTimeoutMinMs + Math.random() * (electionTimeoutMaxMs - electionTimeoutMinMs);
  }
}

// =============================================================================
// WORKLOAD SCHEDULER
// =============================================================================

export class WorkloadScheduler extends EventEmitter {
  private workloads: Map<string, Workload> = new Map();
  private getAliveNodes: () => NodeInfo[];

  constructor(getAliveNodes: () => NodeInfo[]) {
    super();
    this.getAliveNodes = getAliveNodes;
  }

  submit(workload: Omit<Workload, "id" | "status" | "assignedNodes" | "createdAt">): Workload {
    const w: Workload = {
      ...workload,
      id: crypto.randomUUID(),
      status: "pending",
      assignedNodes: [],
      createdAt: Date.now(),
    };
    this.workloads.set(w.id, w);
    this.scheduleWorkload(w);
    return w;
  }

  getWorkload(id: string): Workload | undefined {
    return this.workloads.get(id);
  }

  getAllWorkloads(): Workload[] {
    return Array.from(this.workloads.values());
  }

  private scheduleWorkload(workload: Workload): void {
    workload.status = "scheduling";
    const candidates = this.findCandidateNodes(workload);

    if (candidates.length < workload.replicas) {
      workload.status = "failed";
      this.emit("schedulingFailed", workload, "insufficient nodes");
      return;
    }

    // Sort by load (least loaded first) — bin-packing
    candidates.sort((a, b) => a.load - b.load);
    workload.assignedNodes = candidates.slice(0, workload.replicas).map((n) => n.id);
    workload.status = "running";

    this.emit("workloadScheduled", workload);
  }

  private findCandidateNodes(workload: Workload): NodeInfo[] {
    let candidates = this.getAliveNodes();

    for (const constraint of workload.constraints) {
      switch (constraint.type) {
        case "capability":
          candidates = candidates.filter((n) => n.capabilities.includes(constraint.value));
          break;
        case "max-load":
          candidates = candidates.filter((n) => n.load <= parseFloat(constraint.value));
          break;
        case "anti-affinity":
          candidates = candidates.filter((n) => !n.metadata["workload"]?.includes(constraint.value));
          break;
      }
    }

    return candidates;
  }
}

// =============================================================================
// DECENTRALIZED ORCHESTRATOR (top-level)
// =============================================================================

export class DecentralizedOrchestrator extends EventEmitter {
  readonly gossip: GossipProtocol;
  readonly election: LeaderElection;
  readonly scheduler: WorkloadScheduler;
  private readonly config: OrchestratorConfig;

  constructor(config: Partial<OrchestratorConfig> = {}, capabilities: string[] = []) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gossip = new GossipProtocol(this.config, capabilities);
    this.election = new LeaderElection(
      this.gossip.nodeId,
      this.config,
      () => this.gossip.aliveNodes
    );
    this.scheduler = new WorkloadScheduler(() => this.gossip.aliveNodes);

    this.wireEvents();
  }

  get nodeId(): string {
    return this.gossip.nodeId;
  }

  get isLeader(): boolean {
    return this.election.isLeader;
  }

  start(): void {
    this.gossip.start();
    this.election.start();
    this.emit("started", this.nodeId);
  }

  stop(): void {
    this.election.stop();
    this.gossip.stop();
    this.emit("stopped", this.nodeId);
  }

  submitWorkload(workload: Omit<Workload, "id" | "status" | "assignedNodes" | "createdAt">): Workload | null {
    if (!this.election.isLeader) {
      this.emit("error", "Only leader can schedule workloads");
      return null;
    }
    return this.scheduler.submit(workload);
  }

  private wireEvents(): void {
    // Forward gossip election messages to election module
    this.gossip.on("message", (msg: GossipMessage) => {
      if (msg.type === "election" || msg.type === "vote" || msg.type === "leader") {
        this.election.handleElectionMessage(msg);
      }
      if (msg.type === "workload") {
        this.emit("workloadMessage", msg);
      }
    });

    // Election broadcasts go through gossip
    this.election.on("requestVotes", (msg: GossipMessage) => this.gossip.handleMessage(msg));
    this.election.on("sendVote", (msg: GossipMessage) => this.gossip.handleMessage(msg));
    this.election.on("announceLeader", (msg: GossipMessage) => this.gossip.handleMessage(msg));

    // Forward interesting events
    this.election.on("becameLeader", (term: number) => this.emit("becameLeader", term));
    this.election.on("leaderElected", (id: string) => this.emit("leaderElected", id));
    this.scheduler.on("workloadScheduled", (w: Workload) => this.emit("workloadScheduled", w));
    this.scheduler.on("schedulingFailed", (w: Workload, reason: string) =>
      this.emit("schedulingFailed", w, reason)
    );
  }
}
