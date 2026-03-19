import { connect, NatsConnection, StringCodec } from "nats";
import { log, logError, logWarn } from "../../logger";

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
      logError(`❌ NATS connection failed (${this.url})`, err as Error);
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

  async close() {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
      log("NATS disconnected", "nats");
    }
  }
}

export const natsPublisher = new NatsPublisher();
