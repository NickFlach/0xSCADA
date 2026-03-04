/**
 * Governance Gate Manager
 * Issue #345: Implement governance gate pattern
 * 
 * Manages gate definitions, instances, state transitions, and audit trails.
 * Integrates with the verification pipeline for automated gate conditions.
 */

import { EventEmitter } from 'events';
import pino from 'pino';
import crypto from 'crypto';
const uuid = () => crypto.randomUUID();
import type {
  IGateManager,
  GateDefinition,
  GateInstance,
  GateState,
  GateTransition,
  AuditEntry,
} from './types';
import { VerificationPipeline } from '../verification/pipeline';
import type { VerificationInput, PipelineResult } from '../verification/types';

const logger = pino({ name: 'gate-manager' });

export class GateManager extends EventEmitter implements IGateManager {
  private definitions: Map<string, GateDefinition> = new Map();
  private instances: Map<string, GateInstance> = new Map();

  // ─── Gate Definitions ───────────────────────────────────────────────────

  registerGate(definition: GateDefinition): void {
    this.definitions.set(definition.id, definition);
    logger.info({ gateId: definition.id, name: definition.name }, 'Gate definition registered');
  }

  getDefinition(id: string): GateDefinition | undefined {
    return this.definitions.get(id);
  }

  // ─── Instance Lifecycle ─────────────────────────────────────────────────

  async createInstance(
    definitionId: string,
    subject: GateInstance['subject'],
    actor: string,
  ): Promise<GateInstance> {
    const definition = this.definitions.get(definitionId);
    if (!definition) throw new Error(`Gate definition "${definitionId}" not found`);

    const instanceId = uuid();
    const now = new Date().toISOString();

    const instance: GateInstance = {
      id: instanceId,
      definitionId,
      state: 'pending',
      subject,
      approvals: [],
      auditTrail: [],
      createdAt: now,
      expiresAt: definition.timeoutMs > 0
        ? new Date(Date.now() + definition.timeoutMs).toISOString()
        : undefined,
    };

    // Record initial audit entry
    instance.auditTrail.push(this.createAuditEntry(instanceId, 'submit', 'initial', 'pending', actor));

    // Run automated verification conditions
    if (definition.type === 'automated' || definition.type === 'hybrid') {
      const verificationConditions = definition.conditions.filter(c => c.type === 'verification');
      if (verificationConditions.length > 0) {
        const pipeline = new VerificationPipeline(verificationConditions[0].verificationConfig);
        const verInput: VerificationInput = {
          id: subject.id,
          data: subject.data,
        };
        instance.verificationResult = await pipeline.execute(verInput);

        if (definition.type === 'automated') {
          // Auto-resolve based on verification result
          if (instance.verificationResult.status === 'pass') {
            instance.state = 'approved';
            instance.resolvedAt = new Date().toISOString();
            instance.auditTrail.push(
              this.createAuditEntry(instanceId, 'approve', 'pending', 'approved', 'system', 'Automated verification passed')
            );
          } else {
            instance.state = 'rejected';
            instance.resolvedAt = new Date().toISOString();
            instance.auditTrail.push(
              this.createAuditEntry(instanceId, 'reject', 'pending', 'rejected', 'system',
                `Automated verification failed: ${instance.verificationResult.summary.highestSeverity}`)
            );
          }
        }
      }
    }

    this.instances.set(instanceId, instance);
    this.emit('gate:created', instance);
    if (instance.state !== 'pending') {
      this.emit(`gate:${instance.state}`, instance);
    }

    logger.info({ instanceId, definitionId, state: instance.state }, 'Gate instance created');
    return instance;
  }

  async submitDecision(
    instanceId: string,
    approver: string,
    action: 'approve' | 'reject',
    comment?: string,
  ): Promise<GateInstance> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Gate instance "${instanceId}" not found`);

    const definition = this.definitions.get(instance.definitionId);
    if (!definition) throw new Error(`Gate definition "${instance.definitionId}" not found`);

    if (instance.state !== 'pending') {
      throw new Error(`Gate instance "${instanceId}" is in state "${instance.state}", not pending`);
    }

    // Validate approver
    if (definition.approvers.length > 0 && !definition.approvers.includes(approver)) {
      throw new Error(`"${approver}" is not an authorized approver for this gate`);
    }

    // Check for duplicate approval
    if (instance.approvals.some(a => a.approver === approver)) {
      throw new Error(`"${approver}" has already submitted a decision`);
    }

    // Record the approval
    instance.approvals.push({
      approver,
      action,
      comment,
      timestamp: new Date().toISOString(),
    });

    // Check if we have enough decisions
    if (action === 'reject') {
      this.transition(instance, 'reject', approver, comment);
    } else {
      const approveCount = instance.approvals.filter(a => a.action === 'approve').length;
      if (approveCount >= definition.requiredApprovals) {
        this.transition(instance, 'approve', approver, comment);
      }
    }

    return instance;
  }

  async override(instanceId: string, actor: string, reason: string): Promise<GateInstance> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Gate instance "${instanceId}" not found`);

    const definition = this.definitions.get(instance.definitionId);
    if (!definition?.allowOverride) {
      throw new Error(`Override not allowed for gate "${instance.definitionId}"`);
    }

    this.transition(instance, 'override', actor, reason);
    return instance;
  }

  async cancel(instanceId: string, actor: string, reason?: string): Promise<GateInstance> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Gate instance "${instanceId}" not found`);
    if (instance.state !== 'pending') {
      throw new Error(`Cannot cancel gate in state "${instance.state}"`);
    }

    this.transition(instance, 'cancel', actor, reason);
    return instance;
  }

  getInstance(instanceId: string): GateInstance | undefined {
    return this.instances.get(instanceId);
  }

  getInstances(definitionId: string): GateInstance[] {
    return Array.from(this.instances.values()).filter(i => i.definitionId === definitionId);
  }

  async checkTimeouts(): Promise<GateInstance[]> {
    const now = Date.now();
    const timedOut: GateInstance[] = [];

    for (const instance of this.instances.values()) {
      if (
        instance.state === 'pending' &&
        instance.expiresAt &&
        new Date(instance.expiresAt as string).getTime() <= now
      ) {
        this.transition(instance, 'timeout', 'system', 'Gate timed out');
        timedOut.push(instance);
      }
    }

    return timedOut;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private transition(
    instance: GateInstance,
    transition: GateTransition,
    actor: string,
    reason?: string,
  ): void {
    const fromState = instance.state;
    const toState = this.resolveTransition(transition);

    instance.auditTrail.push(
      this.createAuditEntry(instance.id, transition, fromState, toState, actor, reason)
    );

    instance.state = toState;
    instance.resolvedAt = new Date().toISOString();

    this.emit(`gate:${toState}`, instance);
    logger.info({ instanceId: instance.id, fromState, toState, transition, actor }, 'Gate transition');
  }

  private resolveTransition(transition: GateTransition): GateState {
    switch (transition) {
      case 'approve':
      case 'override':
        return 'approved';
      case 'reject':
        return 'rejected';
      case 'timeout':
        return 'timed_out';
      case 'cancel':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  private createAuditEntry(
    gateId: string,
    transition: GateTransition,
    fromState: GateState | 'initial',
    toState: GateState,
    actor: string,
    reason?: string,
  ): AuditEntry {
    return {
      id: uuid(),
      gateId,
      transition,
      fromState,
      toState,
      actor,
      reason,
      timestamp: new Date().toISOString(),
    };
  }
}
