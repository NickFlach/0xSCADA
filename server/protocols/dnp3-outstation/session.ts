/**
 * DNP3 Outstation — per-association application state.
 *
 * Issue #464.
 *
 * These three declarations used to live in `index.ts`. They were lifted out
 * unchanged when the TCP listener moved into `server.ts` (#464 follow-up):
 * the transport needs to hold one session per connection, and `index.ts` needs
 * the listener, so leaving them in `index.ts` would make the two modules import
 * each other. `index.ts` re-exports everything here, so no existing import path
 * changes.
 */

/** One fragment of an application response, plus what it commits the outstation to. */
export interface Dnp3ResponseFragment {
  /** the application fragment octets (header + objects) */
  bytes: Buffer;
  /** application sequence number carried in the fragment header */
  seq: number;
  /** CON bit — the master must send an application CONFIRM for this fragment */
  con: boolean;
  /** event-buffer sequence numbers carried; removed from the buffer on CONFIRM */
  eventSeqs: number[];
}

/**
 * Per-master-association application-layer state. An outstation may only have
 * one response outstanding at a time, so this holds the fragment awaiting a
 * CONFIRM plus any fragments queued behind it.
 */
export interface OutstationSession {
  pendingFragments: Dnp3ResponseFragment[];
  awaitingConfirm: Dnp3ResponseFragment | null;
}

export function createSession(): OutstationSession {
  return { pendingFragments: [], awaitingConfirm: null };
}
