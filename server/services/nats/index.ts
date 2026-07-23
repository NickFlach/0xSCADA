import { connect, NatsConnection, StringCodec } from "nats";
import { log, logError, logWarn } from "../../logger";
import {
  SCADA_EVENTS_SUBJECT,
  buildScadaEventWire,
  type ScadaEventWire,
} from "../../../shared/wire-schema/scada-event";
import { anchorsToNode } from "../../bridge/anchor-backend";

const sc = StringCodec();

class NatsPublisher {
  private nc: NatsConnection | null = null;
  private url: string;

  constructor() {
    this.url = process.env.NATS_URL || "nats://swarm.ninja-portal.com:4222";
  }

  async connect() {
    try {
      this.nc = await connect({ servers: this.url });
      log(`✅ NATS connected to ${this.url}`, "nats");
    } catch (err) {
      logError(err, `❌ NATS connection failed (${this.url})`);
    }
  }

  publish(subject: string, data: object) {
    if (!this.nc) return;
    try {
      this.nc.publish(subject, sc.encode(JSON.stringify(data)));
    } catch (err) {
      logWarn(`NATS publish failed on ${subject}: ${err}`, "nats");
    }
  }

  /**
   * Publish a SCADA event on the canonical `scada.events` wire schema
   * (issue #440). Validation failures are loud: a payload the Rust node
   * cannot parse must never leave this process silently.
   *
   * Respects ANCHOR_BACKEND (#443): when the operator pins anchoring to
   * the legacy L2 path, nothing is published toward the node.
   */
  publishScadaEvent(event: ScadaEventWire) {
    if (!anchorsToNode()) return;
    let wire: ScadaEventWire;
    try {
      wire = buildScadaEventWire(event);
    } catch (err) {
      logError(err as Error, "NATS scada.events payload violates the wire schema — dropped");
      return;
    }
    this.publish(SCADA_EVENTS_SUBJECT, wire);
  }

  async close() {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
      log("NATS disconnected", "nats");
    }
  }
}

export const natsPublisher = new NatsPublisher();
