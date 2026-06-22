/**
 * IEC 61850 GOOSE — shared types.
 *
 * GOOSE (Generic Object Oriented Substation Event) is the IEC 61850-8-1
 * multicast Layer-2 publish/subscribe mechanism used for fast (sub-4ms)
 * inter-IED messaging in substations. This module is the SUBSCRIBER side
 * (the publisher is implemented in a later wave).
 *
 * Frame layout on the wire (Ethernet II, no IP/UDP):
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ Dest MAC (6) │ Src MAC (6) │ [802.1Q VLAN tag (4, optional)]    │
 *   │ EtherType 0x88B8 (2)                                            │
 *   │ APPID (2) │ Length (2) │ Reserved1 (2) │ Reserved2 (2)          │   ← GOOSE link header
 *   │ APDU: IEC 61850-8-1 IECGoosePdu (ASN.1 BER, application tag 0x61)│
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Issue: #465 — Build IEC 61850 GOOSE Subscriber.
 */

/** EtherType identifying a GOOSE frame (IEC 61850-8-1). */
export const GOOSE_ETHERTYPE = 0x88b8;

/** 802.1Q VLAN tag protocol identifier (TPID). */
export const VLAN_TPID = 0x8100;

/**
 * Quality bitfield as defined in IEC 61850-7-3 (the `Quality` CDC, BITSTRING).
 * Decoded from the GOOSE dataset member when present.
 */
export interface GooseQuality {
  /** validity: good | invalid | reserved | questionable */
  validity: "good" | "invalid" | "reserved" | "questionable";
  /** detailQual.overflow */
  overflow: boolean;
  /** detailQual.outOfRange */
  outOfRange: boolean;
  /** detailQual.badReference */
  badReference: boolean;
  /** detailQual.oscillatory */
  oscillatory: boolean;
  /** detailQual.failure */
  failure: boolean;
  /** detailQual.oldData */
  oldData: boolean;
  /** detailQual.inconsistent */
  inconsistent: boolean;
  /** detailQual.inaccurate */
  inaccurate: boolean;
  /** source: process | substituted */
  source: "process" | "substituted";
  /** test flag */
  test: boolean;
  /** operatorBlocked */
  operatorBlocked: boolean;
}

/**
 * Discriminated union of decoded GOOSE dataset member values.
 * Mirrors the IEC 61850-8-1 `Data` CHOICE (only the common encodings the
 * subscriber needs are implemented; see frame-parser TODOs for the rest).
 */
export type GooseDataValue =
  | { type: "boolean"; value: boolean }
  | { type: "int"; value: number }
  | { type: "uint"; value: number }
  | { type: "float"; value: number }
  | { type: "bitstring"; value: { bits: boolean[]; unusedBits: number } }
  | { type: "quality"; value: GooseQuality }
  | { type: "octetstring"; value: Buffer }
  | { type: "visiblestring"; value: string }
  | { type: "utctime"; value: { seconds: number; fraction: number; quality: number } }
  | { type: "structure"; value: GooseDataValue[] }
  | { type: "unknown"; tag: number; raw: Buffer };

/**
 * Decoded IEC 61850-8-1 IECGoosePdu.
 * Field names follow the ASN.1 definition (IEC 61850-8-1 Annex A).
 */
export interface GoosePdu {
  /** GOOSE Control Block reference, e.g. "IED1LD0/LLN0$GO$gcb01" */
  gocbRef: string;
  /** timeAllowedToLive in milliseconds — max time until next retransmission */
  timeAllowedToLive: number;
  /** dataSet reference, e.g. "IED1LD0/LLN0$DataSet1" */
  datSet: string;
  /** goID (optional control-block ID string) */
  goID: string;
  /** event timestamp (EntryTime / UTCTime — ms since epoch) */
  t: number;
  /** state number — increments on every dataset value change */
  stNum: number;
  /** sequence number — increments on each retransmission, resets on stNum change */
  sqNum: number;
  /** test flag */
  simulation: boolean;
  /** confRev — configuration revision of the GOOSE control block */
  confRev: number;
  /** ndsCom — needs commissioning flag */
  ndsCom: boolean;
  /** number of dataset entries */
  numDatSetEntries: number;
  /** decoded dataset members, in order */
  allData: GooseDataValue[];
}

/**
 * Result of parsing a full GOOSE Ethernet frame (link header + APDU).
 */
export interface GooseFrame {
  /** destination MAC, lowercased colon-hex, e.g. "01:0c:cd:01:00:01" */
  destMac: string;
  /** source MAC */
  srcMac: string;
  /** 802.1Q VLAN id, if a VLAN tag was present */
  vlanId?: number;
  /** 802.1Q priority code point, if a VLAN tag was present */
  vlanPriority?: number;
  /** APPID from the GOOSE link header */
  appId: number;
  /** Length field from the link header (bytes of APDU + header from APPID) */
  length: number;
  /** decoded APDU */
  pdu: GoosePdu;
}

/**
 * A tag update surfaced from a decoded GOOSE dataset member.
 * `origin` is fixed to "goose" so downstream consumers can attribute provenance.
 *
 * INTEGRATION (#206 tag-stream): this maps onto `server/websocket/tag-stream.ts`
 * `TagUpdate`; the base type does not (yet) carry an `origin` discriminator, so
 * we keep our own richer shape here and adapt at the emit seam in index.ts.
 */
export interface GooseTagUpdate {
  tagName: string;
  value: number | string | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: string;
  origin: "goose";
  /** GOOSE control block this update came from */
  gocbRef: string;
  /** state number of the GOOSE message that produced this value */
  stNum: number;
  /** true when the publisher flagged the message as simulated/test */
  simulated: boolean;
}
