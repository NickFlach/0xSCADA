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
      this.nc = null;
      logError(err, `❌ NATS connection failed (${this.url})`);
    }
  }

  isConnected(): boolean {
    return this.nc !== null && !this.nc.isClosed();
  }

  publish(subject: string, data: object): boolean {
    if (!this.isConnected() || !this.nc) return false;
    try {
      this.nc.publish(subject, sc.encode(JSON.stringify(data)));
      return true;
    } catch (err) {
      logWarn(`NATS publish failed on ${subject}: ${err}`, "nats");
      return false;
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
