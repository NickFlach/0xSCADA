/**
 * Event API Types
 * 
 * Types for event streaming and real-time notifications.
 */

import { EntityId, Timestamp, BaseEvent } from '../core/common';

export interface EventSubscription {
  id: EntityId;
  filters: EventFilters;
  clientId: string;
  createdAt: Timestamp;
  eventsMatched: number;
}

export interface EventFilters {
  siteIds?: string[];
  assetIds?: string[];
  eventTypes?: string[];
  severities?: string[];
  timeRange?: {
    start: Timestamp;
    end: Timestamp;
  };
}

export interface StreamedEvent extends BaseEvent {
  subscriptionId: EntityId;
  sequence: number;
}