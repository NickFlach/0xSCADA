import type { DeliveryChannel, DeliveryPayload, DeliveryReceipt } from "./types";

export class DeliveryChannelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DeliveryChannelError";
  }
}

export interface WebhookTransport {
  post(request: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<{ status: number; requestId?: string }>;
}

export interface EmailTransport {
  send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    headers: Readonly<Record<string, string>>;
  }): Promise<{ messageId?: string }>;
}

/**
 * Executable webhook adapter with the network operation injected.  Tests and
 * the default engine never perform live HTTP.
 */
export class WebhookDeliveryChannel implements DeliveryChannel {
  readonly method = "webhook" as const;

  constructor(private readonly transport: WebhookTransport) {}

  async send(payload: DeliveryPayload): Promise<DeliveryReceipt> {
    const target = validateWebhookTarget(payload.target);
    validateHeaders(payload.headers, [
      "content-type",
      "x-0xscada-delivery-id",
      "x-0xscada-report-id",
    ]);
    const response = await this.transport.post({
      url: target,
      headers: {
        ...payload.headers,
        "content-type": "application/json",
        "x-0xscada-delivery-id": payload.deliveryId,
        "x-0xscada-report-id": payload.report.id,
      },
      body: payload.json,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new DeliveryChannelError(
        `Webhook returned HTTP ${response.status}`,
        response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
        response.status,
      );
    }
    return { statusCode: response.status, providerId: response.requestId };
  }
}

/** Email provider adapter; SMTP/API details remain deployment-owned. */
export class EmailDeliveryChannel implements DeliveryChannel {
  readonly method = "email" as const;

  constructor(private readonly transport: EmailTransport) {}

  async send(payload: DeliveryPayload): Promise<DeliveryReceipt> {
    if (!isPlausibleEmail(payload.target)) {
      throw new DeliveryChannelError("Invalid email delivery target", false);
    }
    if (/[\r\n]/.test(payload.subject)) {
      throw new DeliveryChannelError("Email subject contains a newline", false);
    }
    validateHeaders(payload.headers, ["x-0xscada-delivery-id", "x-0xscada-report-id"]);
    try {
      const response = await this.transport.send({
        to: payload.target,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        headers: {
          ...payload.headers,
          "x-0xscada-delivery-id": payload.deliveryId,
          "x-0xscada-report-id": payload.report.id,
        },
      });
      return { providerId: response.messageId };
    } catch (error) {
      if (error instanceof DeliveryChannelError) throw error;
      throw new DeliveryChannelError(error instanceof Error ? error.message : String(error), true);
    }
  }
}

function validateWebhookTarget(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new DeliveryChannelError("Invalid webhook URL", false);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new DeliveryChannelError(
      "Webhook URL must use HTTP(S) and must not contain credentials",
      false,
    );
  }
  return url.toString();
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateHeaders(
  headers: Readonly<Record<string, string>>,
  reserved: readonly string[] = [],
): void {
  const reservedNames = new Set(reserved.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(headers)) {
    if (!name || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) {
      throw new DeliveryChannelError("Invalid delivery header", false);
    }
    if (reservedNames.has(name.toLowerCase())) {
      throw new DeliveryChannelError(`Delivery header ${name} is reserved`, false);
    }
  }
}
