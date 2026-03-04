/**
 * Event Stream Component
 * 
 * Issue #9: [Track A2.1] Build Real-Time Event Stream Component
 * 
 * Real-time event stream display with:
 * - WebSocket connection
 * - Auto-scroll toggle
 * - Event filtering
 * - Connection status indicator
 * - Virtualized list for performance
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./card";
import { Badge } from "./badge";
import { Button } from "./button";
import { ScrollArea } from "./scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";
import {
  Radio,
  Wifi,
  WifiOff,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Pause,
  Play,
  Trash2,
  Filter,
  Activity,
  Bell,
  Terminal,
  Wrench,
  FileCode,
  Upload,
  Settings,
} from "lucide-react";
import { useEventStream } from "../../hooks/use-event-stream";
import type { ConnectionStatus } from "../../hooks/use-websocket";

// =============================================================================
// TYPES
// =============================================================================

export interface EventFilter {
  siteId?: string;
  eventType?: string;
  fromTime?: Date;
  toTime?: Date;
}

export interface StreamEvent {
  id: string;
  eventType: string;
  siteId?: string;
  assetId?: string;
  details?: string;
  sourceTimestamp: string | Date;
}

export interface EventStreamProps {
  /** Maximum number of events to display */
  maxEvents?: number;
  /** Initial filter */
  filter?: EventFilter;
  /** Show filter controls */
  showFilters?: boolean;
  /** Available sites for filtering */
  sites?: Array<{ id: string; name: string }>;
  /** Available event types for filtering */
  eventTypes?: string[];
  /** Height of the component */
  height?: string;
  /** Callback when event is clicked */
  onEventClick?: (event: StreamEvent) => void;
  /** Compact mode */
  compact?: boolean;
}

// =============================================================================
// CONNECTION STATUS INDICATOR
// =============================================================================

function ConnectionStatusIndicator({
  status,
  reconnectAttempts,
}: {
  status: ConnectionStatus;
  reconnectAttempts: number;
}) {
  const config = {
    connected: {
      icon: Wifi,
      color: "text-green-500",
      bgColor: "bg-green-500/20",
      label: "Connected",
    },
    connecting: {
      icon: Loader2,
      color: "text-yellow-500",
      bgColor: "bg-yellow-500/20",
      label: "Connecting...",
    },
    disconnected: {
      icon: WifiOff,
      color: "text-gray-500",
      bgColor: "bg-gray-500/20",
      label: reconnectAttempts > 0 ? `Reconnecting (${reconnectAttempts})...` : "Disconnected",
    },
    error: {
      icon: AlertTriangle,
      color: "text-red-500",
      bgColor: "bg-red-500/20",
      label: "Connection Error",
    },
  };

  const { icon: Icon, color, bgColor, label } = config[status];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${bgColor}`}>
            <Icon
              className={`w-3.5 h-3.5 ${color} ${status === "connecting" ? "animate-spin" : ""}`}
            />
            <span className={`text-xs font-medium ${color}`}>
              {status === "connected" ? "Live" : label}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// =============================================================================
// EVENT TYPE ICON
// =============================================================================

function EventTypeIcon({ type }: { type: string }) {
  const icons: Record<string, React.ComponentType<{ className?: string }>> = {
    TELEMETRY: Activity,
    ALARM: Bell,
    COMMAND: Terminal,
    ACKNOWLEDGEMENT: Settings,
    MAINTENANCE: Wrench,
    BLUEPRINT_CHANGE: FileCode,
    CODE_GENERATION: FileCode,
    DEPLOYMENT_INTENT: Upload,
  };

  const Icon = icons[type] || Radio;
  return <Icon className="w-4 h-4" />;
}

// =============================================================================
// EVENT TYPE BADGE
// =============================================================================

function EventTypeBadge({ type }: { type: string }) {
  const variants: Record<string, string> = {
    TELEMETRY: "bg-blue-500/20 text-blue-500 border-blue-500/50",
    ALARM: "bg-red-500/20 text-red-500 border-red-500/50",
    COMMAND: "bg-purple-500/20 text-purple-500 border-purple-500/50",
    ACKNOWLEDGEMENT: "bg-green-500/20 text-green-500 border-green-500/50",
    MAINTENANCE: "bg-orange-500/20 text-orange-500 border-orange-500/50",
    BLUEPRINT_CHANGE: "bg-cyan-500/20 text-cyan-500 border-cyan-500/50",
    CODE_GENERATION: "bg-pink-500/20 text-pink-500 border-pink-500/50",
    DEPLOYMENT_INTENT: "bg-yellow-500/20 text-yellow-500 border-yellow-500/50",
  };

  return (
    <Badge
      variant="outline"
      className={`text-xs font-mono ${variants[type] || "bg-gray-500/20 text-gray-500"}`}
    >
      {type}
    </Badge>
  );
}

// =============================================================================
// EVENT ROW
// =============================================================================

function EventRow({
  event,
  onClick,
  compact,
}: {
  event: StreamEvent;
  onClick?: () => void;
  compact?: boolean;
}) {
  const timestamp = new Date(event.sourceTimestamp);
  const timeString = timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return (
    <div
      className={`
        flex items-center gap-3 p-2 rounded-md border border-transparent
        hover:bg-muted/50 hover:border-border/50 cursor-pointer
        transition-colors duration-150
        ${compact ? "py-1.5" : "py-2"}
      `}
      onClick={onClick}
    >
      <div className="flex-shrink-0">
        <EventTypeIcon type={event.eventType} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <EventTypeBadge type={event.eventType} />
          {!compact && event.siteId && (
            <span className="text-xs text-muted-foreground font-mono truncate">
              {event.siteId}
              {event.assetId && ` / ${event.assetId}`}
            </span>
          )}
        </div>
        {event.details && (
          <p className="text-sm text-foreground/80 truncate mt-0.5">{event.details}</p>
        )}
      </div>

      <div className="flex-shrink-0 text-right">
        <span className="text-xs text-muted-foreground font-mono">{timeString}</span>
      </div>
    </div>
  );
}

// =============================================================================
// EVENT STREAM COMPONENT
// =============================================================================

export function EventStream({
  maxEvents = 500,
  filter: initialFilter,
  showFilters = true,
  sites = [],
  eventTypes = [
    "TELEMETRY",
    "ALARM",
    "COMMAND",
    "ACKNOWLEDGEMENT",
    "MAINTENANCE",
    "BLUEPRINT_CHANGE",
    "CODE_GENERATION",
    "DEPLOYMENT_INTENT",
  ],
  height = "500px",
  onEventClick,
  compact = false,
}: EventStreamProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [selectedSite, setSelectedSite] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [displayedEvents, setDisplayedEvents] = useState<StreamEvent[]>([]);

  const {
    events,
    status,
    reconnectAttempts,
    clearEvents,
    connect,
    disconnect,
  } = useEventStream({
    maxEvents,
    filter: initialFilter as any,
    onEvent: (event) => {
      if (!isPaused) {
        setDisplayedEvents((prev) => [event, ...prev].slice(0, maxEvents));
      }
    },
  });

  // Update displayed events when not paused
  useEffect(() => {
    if (!isPaused) {
      setDisplayedEvents(events);
    }
  }, [events, isPaused]);

  // Auto-scroll to top when new events arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current && !isPaused) {
      scrollRef.current.scrollTop = 0;
    }
  }, [displayedEvents, autoScroll, isPaused]);

  // Apply local filter
  const filteredEvents = displayedEvents.filter((event) => {
    if (selectedSite !== "all" && event.siteId !== selectedSite) return false;
    if (selectedType !== "all" && event.eventType !== selectedType) return false;
    return true;
  });

  const handleClear = useCallback(() => {
    clearEvents();
    setDisplayedEvents([]);
  }, [clearEvents]);

  const togglePause = useCallback(() => {
    setIsPaused((prev) => {
      if (prev) {
        // Resuming - sync with current events
        setDisplayedEvents(events);
      }
      return !prev;
    });
  }, [events]);

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Radio className="w-5 h-5 text-primary" />
            Event Stream
            <Badge variant="outline" className="ml-2">
              {filteredEvents.length}
            </Badge>
          </CardTitle>

          <div className="flex items-center gap-2">
            <ConnectionStatusIndicator status={status} reconnectAttempts={reconnectAttempts} />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between gap-4 mt-3">
          <div className="flex items-center gap-2">
            {showFilters && (
              <>
                <Select value={selectedSite} onValueChange={setSelectedSite} {...({} as any)}>
                  <SelectTrigger className="w-[140px] h-8 text-xs">
                    <Filter className="w-3 h-3 mr-1" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sites</SelectItem>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={selectedType} onValueChange={setSelectedType} {...({} as any)}>
                  <SelectTrigger className="w-[150px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {eventTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={togglePause}
                    className="h-8 w-8 p-0"
                  >
                    {isPaused ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{isPaused ? "Resume" : "Pause"} stream</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAutoScroll(!autoScroll)}
                    className={`h-8 w-8 p-0 ${autoScroll ? "text-primary" : ""}`}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Auto-scroll {autoScroll ? "on" : "off"}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClear}
                    className="h-8 w-8 p-0"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Clear events</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ScrollArea style={{ height }} className="px-4">
          <div ref={scrollRef} className="space-y-1 py-2">
            {filteredEvents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                {status === "connected" ? (
                  <>
                    <Radio className="w-8 h-8 mb-2 opacity-50" />
                    <p className="text-sm">Waiting for events...</p>
                    <p className="text-xs mt-1">Events will appear here in real-time</p>
                  </>
                ) : status === "connecting" ? (
                  <>
                    <Loader2 className="w-8 h-8 mb-2 animate-spin opacity-50" />
                    <p className="text-sm">Connecting to event stream...</p>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-8 h-8 mb-2 opacity-50" />
                    <p className="text-sm">Not connected</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={connect}
                      className="mt-2"
                    >
                      Connect
                    </Button>
                  </>
                )}
              </div>
            ) : (
              filteredEvents.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  onClick={() => onEventClick?.(event)}
                  compact={compact}
                />
              ))
            )}
          </div>
        </ScrollArea>

        {/* Paused indicator */}
        {isPaused && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2">
            <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600">
              <Pause className="w-3 h-3 mr-1" />
              Paused - {events.length - displayedEvents.length} new events
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default EventStream;
