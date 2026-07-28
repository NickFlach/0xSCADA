import { canonicalJson } from "./hash";

export interface PresentedSiteIdentity {
  siteId: string;
  certificateFingerprint: string;
  issuerFingerprint: string;
  subjectAltNames: readonly string[];
  validFrom: Date;
  validTo: Date;
}

export interface DiscoveredSite {
  siteId: string;
  endpoint: string;
  identity: PresentedSiteIdentity;
  metadata?: Readonly<Record<string, string>>;
}

export interface SiteDiscoveryProvider {
  readonly name: string;
  discover(signal?: AbortSignal): Promise<readonly DiscoveredSite[]>;
}

export interface SiteIdentityDecision {
  accepted: boolean;
  reason?: string;
}

export interface SiteIdentityPolicy {
  verify(site: DiscoveredSite, now?: Date): SiteIdentityDecision;
}

/**
 * mTLS contract for federation peers. The transport terminates TLS; this policy
 * binds the presented certificate to the claimed site namespace.
 */
export class MutualTlsSiteIdentityPolicy implements SiteIdentityPolicy {
  private readonly trustedIssuers: ReadonlySet<string>;
  private readonly pinnedSites: ReadonlyMap<string, string>;

  constructor(options: {
    trustedIssuerFingerprints: readonly string[];
    pinnedSiteFingerprints?: Readonly<Record<string, string>>;
  }) {
    this.trustedIssuers = new Set(
      options.trustedIssuerFingerprints.map(normalizeFingerprint),
    );
    this.pinnedSites = new Map(
      Object.entries(options.pinnedSiteFingerprints ?? {}).map(
        ([siteId, fingerprint]) => [siteId, normalizeFingerprint(fingerprint)],
      ),
    );
  }

  verify(site: DiscoveredSite, now = new Date()): SiteIdentityDecision {
    const identity = site.identity;
    let endpoint: URL;
    try {
      endpoint = new URL(site.endpoint);
    } catch {
      return { accepted: false, reason: "site endpoint is not a valid URL" };
    }
    if (endpoint.protocol !== "https:") {
      return { accepted: false, reason: "site endpoint does not require TLS" };
    }
    if (
      !SITE_SEGMENT.test(site.siteId) ||
      !identity.certificateFingerprint.trim()
    ) {
      return { accepted: false, reason: "site identity is incomplete" };
    }
    if (identity.siteId !== site.siteId) {
      return { accepted: false, reason: "certificate site id does not match advert" };
    }
    if (
      !this.trustedIssuers.has(normalizeFingerprint(identity.issuerFingerprint))
    ) {
      return { accepted: false, reason: "certificate issuer is not trusted" };
    }
    if (now < identity.validFrom || now > identity.validTo) {
      return { accepted: false, reason: "certificate is outside its validity window" };
    }
    if (
      !identity.subjectAltNames.includes(`urn:0xscada:site:${identity.siteId}`)
    ) {
      return {
        accepted: false,
        reason: "certificate is missing the site-bound subject alternative name",
      };
    }
    const pinned = this.pinnedSites.get(site.siteId);
    if (
      pinned &&
      pinned !== normalizeFingerprint(identity.certificateFingerprint)
    ) {
      return { accepted: false, reason: "certificate does not match site pin" };
    }
    return { accepted: true };
  }
}

export interface DiscoveryResult {
  sites: DiscoveredSite[];
  rejected: Array<{
    provider: string;
    siteId: string;
    reason: string;
  }>;
}

/**
 * Combines registry and local discovery providers. A namespace is accepted only
 * if every accepted advertisement for it presents the same certificate.
 */
export class FederatedSiteDiscovery {
  constructor(
    private readonly providers: readonly SiteDiscoveryProvider[],
    private readonly identityPolicy: SiteIdentityPolicy,
  ) {}

  async discover(signal?: AbortSignal): Promise<DiscoveryResult> {
    const settled = await Promise.allSettled(
      this.providers.map((provider) =>
        Promise.resolve().then(() => provider.discover(signal)),
      ),
    );
    const sites = new Map<string, DiscoveredSite>();
    const conflictedNamespaces = new Set<string>();
    const rejected: DiscoveryResult["rejected"] = [];

    settled.forEach((result, providerIndex) => {
      const provider = this.providers[providerIndex];
      if (result.status === "rejected") {
        rejected.push({
          provider: provider.name,
          siteId: "*",
          reason: errorMessage(result.reason),
        });
        return;
      }
      for (const site of result.value) {
        if (conflictedNamespaces.has(site.siteId)) {
          rejected.push({
            provider: provider.name,
            siteId: site.siteId,
            reason: "site namespace was rejected after conflicting certificates",
          });
          continue;
        }
        const decision = this.identityPolicy.verify(site);
        if (!decision.accepted) {
          rejected.push({
            provider: provider.name,
            siteId: site.siteId,
            reason: decision.reason ?? "site identity rejected",
          });
          continue;
        }
        const existing = sites.get(site.siteId);
        if (
          existing &&
          normalizeFingerprint(existing.identity.certificateFingerprint) !==
            normalizeFingerprint(site.identity.certificateFingerprint)
        ) {
          sites.delete(site.siteId);
          conflictedNamespaces.add(site.siteId);
          rejected.push({
            provider: provider.name,
            siteId: site.siteId,
            reason: "conflicting certificates advertised for site namespace",
          });
          continue;
        }
        if (
          !existing ||
          `${provider.name}\0${site.endpoint}` <
            `${provider.name}\0${existing.endpoint}`
        ) {
          sites.set(site.siteId, site);
        }
      }
    });

    return {
      sites: [...sites.values()].sort((left, right) =>
        left.siteId.localeCompare(right.siteId),
      ),
      rejected,
    };
  }
}

export interface RegistryClient {
  listSites(signal?: AbortSignal): Promise<readonly DiscoveredSite[]>;
}

export class RegistrySiteDiscovery implements SiteDiscoveryProvider {
  readonly name = "registry";
  constructor(private readonly client: RegistryClient) {}
  discover(signal?: AbortSignal): Promise<readonly DiscoveredSite[]> {
    return this.client.listSites(signal);
  }
}

/** Adapter seam for an mDNS implementation such as multicast-dns/bonjour. */
export interface MdnsBrowser {
  browse(serviceType: string, signal?: AbortSignal): Promise<readonly DiscoveredSite[]>;
}

export class MdnsSiteDiscovery implements SiteDiscoveryProvider {
  readonly name = "mdns";
  constructor(
    private readonly browser: MdnsBrowser,
    private readonly serviceType = "_0xscada._tcp.local",
  ) {}
  discover(signal?: AbortSignal): Promise<readonly DiscoveredSite[]> {
    return this.browser.browse(this.serviceType, signal);
  }
}

const SITE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const TAG_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,254}$/;

/** Canonical namespace-qualified address: `site:area/tag`. */
export class CrossSiteTagReference {
  private constructor(
    readonly site: string,
    readonly area: string,
    readonly tag: string,
  ) {}

  static parse(value: string): CrossSiteTagReference {
    const separator = value.indexOf(":");
    const slash = value.indexOf("/", separator + 1);
    if (separator < 1 || slash <= separator + 1 || slash === value.length - 1) {
      throw new Error(`invalid cross-site tag reference: ${value}`);
    }
    const [site, area, tag] = [
      value.slice(0, separator),
      value.slice(separator + 1, slash),
      value.slice(slash + 1),
    ];
    if (
      !SITE_SEGMENT.test(site) ||
      !SITE_SEGMENT.test(area) ||
      !TAG_SEGMENT.test(tag) ||
      tag.includes("..")
    ) {
      throw new Error(`invalid cross-site tag reference: ${value}`);
    }
    return new CrossSiteTagReference(site, area, tag);
  }

  toString(): string {
    return `${this.site}:${this.area}/${this.tag}`;
  }
}

export interface SiteAlarm {
  id: string;
  tag: string;
  severity: number;
  activeAt: Date;
  message: string;
  acknowledged?: boolean;
}

export interface FederatedAlarm extends SiteAlarm {
  siteId: string;
  federatedId: string;
  tagReference: string;
}

export interface AlarmSource {
  siteId: string;
  activeAlarms(signal?: AbortSignal): Promise<readonly SiteAlarm[]>;
}

export interface FederatedAlarmResult {
  alarms: FederatedAlarm[];
  failures: Array<{ siteId: string; error: string }>;
}

export class FederatedAlarmView {
  constructor(private readonly sources: readonly AlarmSource[]) {}

  async query(signal?: AbortSignal): Promise<FederatedAlarmResult> {
    const sources = [...this.sources].sort((left, right) =>
      left.siteId.localeCompare(right.siteId),
    );
    const settled = await Promise.allSettled(
      sources.map((source) =>
        Promise.resolve().then(() => source.activeAlarms(signal)),
      ),
    );
    const alarms: FederatedAlarm[] = [];
    const failures: FederatedAlarmResult["failures"] = [];
    settled.forEach((result, index) => {
      const source = sources[index];
      if (result.status === "rejected") {
        failures.push({
          siteId: source.siteId,
          error: errorMessage(result.reason),
        });
        return;
      }
      for (const alarm of result.value) {
        const localTag = alarm.tag.replace(/^\/+/, "");
        let tagReference: string;
        try {
          tagReference = CrossSiteTagReference.parse(
            `${source.siteId}:${localTag}`,
          ).toString();
        } catch (error) {
          failures.push({
            siteId: source.siteId,
            error: `invalid alarm tag ${alarm.tag}: ${errorMessage(error)}`,
          });
          continue;
        }
        alarms.push({
          ...alarm,
          siteId: source.siteId,
          federatedId: `${source.siteId}:${alarm.id}`,
          tagReference,
        });
      }
    });
    alarms.sort(
      (left, right) =>
        right.severity - left.severity ||
        left.activeAt.getTime() - right.activeAt.getTime() ||
        left.federatedId.localeCompare(right.federatedId),
    );
    return { alarms, failures };
  }
}

export interface SiteReport<TSection = unknown> {
  siteId: string;
  generate(
    reportType: string,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ): Promise<TSection>;
}

export interface FederatedReport<TSection = unknown> {
  reportType: string;
  from: Date;
  to: Date;
  sections: Array<{ siteId: string; data: TSection }>;
  failures: Array<{ siteId: string; error: string }>;
}

export class FederatedReporting<TSection = unknown> {
  constructor(private readonly sites: readonly SiteReport<TSection>[]) {}

  async generate(
    reportType: string,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ): Promise<FederatedReport<TSection>> {
    if (!reportType.trim() || to < from) {
      throw new Error("report type and a valid time range are required");
    }
    const sites = [...this.sites].sort((left, right) =>
      left.siteId.localeCompare(right.siteId),
    );
    const settled = await Promise.allSettled(
      sites.map((site) =>
        Promise.resolve().then(() =>
          site.generate(reportType, from, to, signal),
        ),
      ),
    );
    const sections: FederatedReport<TSection>["sections"] = [];
    const failures: FederatedReport<TSection>["failures"] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        sections.push({ siteId: sites[index].siteId, data: result.value });
      } else {
        failures.push({
          siteId: sites[index].siteId,
          error: errorMessage(result.reason),
        });
      }
    });
    return { reportType, from, to, sections, failures };
  }
}

export interface LogicalVersion {
  counter: number;
  actor: string;
}

export interface ConfigurationOperation {
  path: string;
  version: LogicalVersion;
  value?: unknown;
  deleted: boolean;
}

export interface ConfigurationConflict {
  path: string;
  winner: ConfigurationOperation;
  loser: ConfigurationOperation;
  reason: "concurrent-write" | "equivocation";
}

/**
 * LWW-map CRDT with Lamport clocks and actor-id tie breaking. Tombstones are
 * retained, making merges associative, commutative, and idempotent.
 */
export class ReplicatedConfiguration {
  private clock = 0;
  private readonly cells = new Map<string, ConfigurationOperation>();
  private readonly observedConflicts: ConfigurationConflict[] = [];

  constructor(readonly actorId: string) {
    if (!actorId.trim()) {
      throw new Error("CRDT actor id cannot be empty");
    }
  }

  set(path: string, value: unknown): ConfigurationOperation {
    validateConfigPath(path);
    if (value === undefined) {
      throw new Error("configuration value cannot be undefined");
    }
    const operation: ConfigurationOperation = {
      path,
      value: structuredClone(value),
      deleted: false,
      version: { counter: ++this.clock, actor: this.actorId },
    };
    this.cells.set(path, operation);
    return cloneOperation(operation);
  }

  delete(path: string): ConfigurationOperation {
    validateConfigPath(path);
    const operation: ConfigurationOperation = {
      path,
      deleted: true,
      version: { counter: ++this.clock, actor: this.actorId },
    };
    this.cells.set(path, operation);
    return cloneOperation(operation);
  }

  apply(operation: ConfigurationOperation): boolean {
    validateOperation(operation);
    this.clock = Math.max(this.clock, operation.version.counter);
    const incoming = cloneOperation(operation);
    const current = this.cells.get(operation.path);
    if (!current) {
      this.cells.set(operation.path, incoming);
      return true;
    }
    const comparison = compareVersions(incoming.version, current.version);
    if (comparison === 0) {
      const incomingCanonical = canonicalJson(incoming);
      const currentCanonical = canonicalJson(current);
      if (incomingCanonical === currentCanonical) {
        return false;
      }
      const incomingWins = incomingCanonical > currentCanonical;
      const winner = incomingWins ? incoming : current;
      const loser = incomingWins ? current : incoming;
      this.observedConflicts.push({
        path: incoming.path,
        winner: cloneOperation(winner),
        loser: cloneOperation(loser),
        reason: "equivocation",
      });
      if (incomingWins) {
        this.cells.set(operation.path, incoming);
      }
      return incomingWins;
    }
    const winner = comparison > 0 ? incoming : current;
    const loser = comparison > 0 ? current : incoming;
    if (
      incoming.version.counter === current.version.counter &&
      canonicalJson(incoming) !== canonicalJson(current)
    ) {
      this.observedConflicts.push({
        path: incoming.path,
        winner: cloneOperation(winner),
        loser: cloneOperation(loser),
        reason: "concurrent-write",
      });
    }
    if (comparison > 0) {
      this.cells.set(operation.path, incoming);
      return true;
    }
    return false;
  }

  merge(other: ReplicatedConfiguration): ConfigurationConflict[] {
    const before = this.observedConflicts.length;
    for (const operation of other.operations()) {
      this.apply(operation);
    }
    return this.observedConflicts.slice(before).map(cloneConflict);
  }

  operations(): ConfigurationOperation[] {
    return [...this.cells.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(cloneOperation);
  }

  conflicts(): ConfigurationConflict[] {
    return this.observedConflicts.map(cloneConflict);
  }

  value(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const operation of this.operations()) {
      if (operation.deleted || hiddenByParentTombstone(operation, this.cells)) {
        continue;
      }
      setNestedValue(result, operation.path.split("."), operation.value);
    }
    return result;
  }
}

function hiddenByParentTombstone(
  operation: ConfigurationOperation,
  cells: ReadonlyMap<string, ConfigurationOperation>,
): boolean {
  const segments = operation.path.split(".");
  for (let length = 1; length < segments.length; length += 1) {
    const parent = cells.get(segments.slice(0, length).join("."));
    if (
      parent?.deleted &&
      compareVersions(parent.version, operation.version) >= 0
    ) {
      return true;
    }
  }
  return false;
}

function setNestedValue(
  root: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor = root;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      cursor[segment] = structuredClone(value);
      return;
    }
    const existing = cursor[segment];
    if (
      !existing ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  });
}

function compareVersions(left: LogicalVersion, right: LogicalVersion): number {
  return (
    left.counter - right.counter || left.actor.localeCompare(right.actor)
  );
}

function validateOperation(operation: ConfigurationOperation): void {
  validateConfigPath(operation.path);
  if (
    !Number.isSafeInteger(operation.version.counter) ||
    operation.version.counter < 1 ||
    !operation.version.actor.trim()
  ) {
    throw new Error("invalid CRDT logical version");
  }
  if (!operation.deleted && operation.value === undefined) {
    throw new Error("non-delete CRDT operation requires a value");
  }
}

function validateConfigPath(path: string): void {
  if (
    !path ||
    path.startsWith(".") ||
    path.endsWith(".") ||
    path.split(".").some((segment) => !SITE_SEGMENT.test(segment))
  ) {
    throw new Error(`invalid configuration path: ${path}`);
  }
}

function cloneOperation(operation: ConfigurationOperation): ConfigurationOperation {
  return structuredClone(operation);
}

function cloneConflict(conflict: ConfigurationConflict): ConfigurationConflict {
  return structuredClone(conflict);
}

function normalizeFingerprint(value: string): string {
  return value.replace(/:/g, "").toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
