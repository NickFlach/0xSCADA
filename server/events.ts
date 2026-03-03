/**
 * Event types and handlers
 */

export interface ServerEvent {
  id: string;
  type: string;
  timestamp: number;
  data: any;
}

export interface SignedEvent extends ServerEvent {
  signature?: string;
  signer?: string;
}

export type EventHandler = (event: ServerEvent) => void;