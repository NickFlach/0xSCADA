/**
 * Rejection-reason coverage for `MutualTlsSiteIdentityPolicy.verify`.
 *
 * The existing federation suite asserts one identity rejection (untrusted
 * issuer) as part of a broader discovery test. Mutation testing showed the
 * other five guards could each be deleted with the whole suite still green:
 *
 *   - certificate siteId vs advertised siteId
 *   - certificate pin for a previously-pinned site
 *   - certificate validity window
 *   - site-bound subject alternative name
 *   - identity completeness
 *
 * That matters more here than in most modules. This policy exists because,
 * without executable identity rules, "sites could silently trust advertisement
 * metadata" — and the siteId-vs-advert check is precisely what stops a peer
 * claiming another site's namespace. A guard whose removal no test notices is
 * one refactor away from not being there.
 *
 * Each test below perturbs exactly one field of an otherwise-valid identity and
 * asserts the specific reason, so a failure names which guard regressed rather
 * than just reporting "identity rejected".
 */
import { describe, expect, it } from "vitest";

import {
  MutualTlsSiteIdentityPolicy,
  type DiscoveredSite,
  type PresentedSiteIdentity,
} from "../federation";

const NOW = new Date("2026-07-28T12:00:00Z");

/** A fully valid advertisement; individual tests break one field at a time. */
function validSite(overrides: Partial<PresentedSiteIdentity> = {}): DiscoveredSite {
  const siteId = "north";
  return {
    siteId,
    endpoint: `https://${siteId}.internal:8443`,
    identity: {
      siteId,
      certificateFingerprint: "north-cert",
      issuerFingerprint: "root-ca",
      subjectAltNames: [`urn:0xscada:site:${siteId}`],
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validTo: new Date("2027-01-01T00:00:00Z"),
      ...overrides,
    },
  };
}

function policy(pins: Record<string, string> = {}): MutualTlsSiteIdentityPolicy {
  return new MutualTlsSiteIdentityPolicy({
    trustedIssuerFingerprints: ["root-ca"],
    pinnedSiteFingerprints: pins,
  });
}

describe("MutualTlsSiteIdentityPolicy rejection reasons (#223)", () => {
  it("accepts a fully valid identity", () => {
    expect(policy().verify(validSite(), NOW)).toEqual({ accepted: true });
  });

  it("rejects a certificate whose siteId disagrees with the advertisement", () => {
    // The core of the threat model: an advert claiming to be `north` while
    // presenting a certificate issued for `south`.
    const candidate = validSite({ siteId: "south" });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate site id does not match advert",
    });
  });

  it("rejects an untrusted issuer", () => {
    const candidate = validSite({ issuerFingerprint: "rogue-ca" });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate issuer is not trusted",
    });
  });

  it("rejects a certificate presented before it is valid", () => {
    const candidate = validSite({
      validFrom: new Date("2026-12-01T00:00:00Z"),
      validTo: new Date("2027-12-01T00:00:00Z"),
    });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate is outside its validity window",
    });
  });

  it("rejects an expired certificate", () => {
    const candidate = validSite({
      validFrom: new Date("2025-01-01T00:00:00Z"),
      validTo: new Date("2026-01-01T00:00:00Z"),
    });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate is outside its validity window",
    });
  });

  it("rejects a certificate missing the site-bound subject alternative name", () => {
    // A certificate valid for some other purpose under the same CA must not be
    // usable as a site identity.
    const candidate = validSite({ subjectAltNames: ["DNS:north.internal"] });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate is missing the site-bound subject alternative name",
    });
  });

  it("rejects an incomplete identity", () => {
    const candidate = validSite({ certificateFingerprint: "   " });

    expect(policy().verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "site identity is incomplete",
    });
  });

  it("rejects a new certificate for an already-pinned site", () => {
    // Rotation vs impersonation. This is distinct from the cross-provider
    // conflict already covered in federation.test.ts: there, two providers
    // disagree in one discovery round. Here a single advert presents a
    // certificate that disagrees with what the operator pinned.
    const candidate = validSite({ certificateFingerprint: "north-cert-v2" });

    expect(policy({ north: "north-cert" }).verify(candidate, NOW)).toEqual({
      accepted: false,
      reason: "certificate does not match site pin",
    });
  });

  it("accepts the pinned certificate for a pinned site", () => {
    expect(policy({ north: "north-cert" }).verify(validSite(), NOW)).toEqual({
      accepted: true,
    });
  });
});
