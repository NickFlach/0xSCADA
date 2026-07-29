/**
 * Pins `validateWebhookTarget` in `WebhookDeliveryChannel`.
 *
 * The guard rejects unparseable URLs, non-HTTP(S) protocols, and credentials
 * embedded in the URL. Mutation testing on the review of #626 showed the whole
 * condition could be neutralised with all 12 existing tests still green — the
 * suite exercises successful webhook delivery, never a rejected target.
 *
 * The credential check is the one most worth holding onto: a target of the
 * form `https://user:pass@host/hook` puts a secret into whatever egress proxy,
 * access log or error report sees the outbound request. That is the kind of
 * check a later refactor drops without noticing, because nothing about the
 * happy path depends on it.
 *
 * Each case asserts the rejection is NON-RETRYABLE. A malformed target is a
 * configuration error, and retrying it just repeats the mistake — including,
 * for the credential case, repeating the leak.
 *
 * SCOPE — this guard is not SSRF protection, and these tests do not pretend
 * otherwise. It checks protocol and credentials; it does not restrict the
 * destination address, so `http://127.0.0.1`, `http://169.254.169.254/` and
 * `http://10.0.0.5:20000` all pass. The final case below documents that
 * explicitly rather than leaving the omission ambiguous. See the review thread
 * on #626 for whether the module should own destination policy or delegate it
 * to the injected transport.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DeliveryChannelError,
  WebhookDeliveryChannel,
  type DeliveryPayload,
  type GeneratedReport,
} from "..";

/** A transport that fails the test if the guard ever lets a request through. */
function transport() {
  return {
    post: vi.fn(async () => ({ status: 200, body: "" })),
  };
}

const REPORT = {
  id: "report-1",
  templateId: "shift-summary",
  title: "Shift Summary",
  generatedAt: new Date("2026-07-28T12:00:00.000Z"),
  periodStart: new Date("2026-07-28T00:00:00.000Z"),
  periodEnd: new Date("2026-07-28T12:00:00.000Z"),
  sections: [],
} as unknown as GeneratedReport;

function payload(target: string): DeliveryPayload {
  return {
    deliveryId: "delivery-1",
    report: REPORT,
    target,
    subject: "Shift Summary",
    headers: {},
    html: "<p>ok</p>",
    text: "ok",
    json: "{}",
  };
}

async function reject(target: string): Promise<DeliveryChannelError> {
  const post = transport();
  const channel = new WebhookDeliveryChannel(post);
  const error = await channel.send(payload(target)).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(DeliveryChannelError);
  // The guard runs before the transport; nothing should have been dispatched.
  expect(post.post).not.toHaveBeenCalled();
  return error as DeliveryChannelError;
}

describe("webhook target validation", () => {
  it("accepts an ordinary https target", async () => {
    const post = transport();
    const channel = new WebhookDeliveryChannel(post);

    await channel.send(payload("https://hooks.example.com/reports"));

    expect(post.post).toHaveBeenCalledTimes(1);
    expect(post.post.mock.calls[0][0]).toMatchObject({
      url: "https://hooks.example.com/reports",
    });
  });

  it("rejects a target that is not a URL at all", async () => {
    const error = await reject("not-a-url");
    expect(error.message).toMatch(/invalid webhook url/i);
    expect(error.retryable).toBe(false);
  });

  it("rejects a non-HTTP(S) protocol", async () => {
    // file:// would make the "delivery" a local read on the server host.
    const error = await reject("file:///etc/passwd");
    expect(error.message).toMatch(/HTTP\(S\)/i);
    expect(error.retryable).toBe(false);
  });

  it("rejects credentials embedded in the URL", async () => {
    // The leak case: these end up in egress proxy and access logs.
    const error = await reject("https://user:secret@hooks.example.com/reports");
    expect(error.message).toMatch(/credentials/i);
    expect(error.retryable).toBe(false);
  });

  it("rejects a username even without a password", async () => {
    const error = await reject("https://user@hooks.example.com/reports");
    expect(error.retryable).toBe(false);
  });

  it("documents that destination filtering is NOT performed here", async () => {
    // Deliberately asserting current behaviour, not endorsing it. This guard
    // is protocol/credential validation only — an internal address passes.
    // If destination policy moves into this module, this test should flip to
    // expecting a rejection, and that change should be a conscious one.
    const post = transport();
    const channel = new WebhookDeliveryChannel(post);

    await channel.send(payload("http://169.254.169.254/latest/meta-data/"));

    expect(post.post).toHaveBeenCalledTimes(1);
  });
});
