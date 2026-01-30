namespace UbiquityBridge.Models;

/// <summary>
/// Remote session type
/// </summary>
public enum SessionType
{
    RemoteDesktop,
    ProcessMonitor
}

/// <summary>
/// Remote session status
/// </summary>
public enum SessionStatus
{
    Pending,
    Connecting,
    Connected,
    Disconnected,
    Error
}

/// <summary>
/// Remote desktop session request
/// </summary>
public record StartSessionRequest
{
    public required string DeviceId { get; init; }
    public SessionType SessionType { get; init; } = SessionType.RemoteDesktop;
    public int? Width { get; init; }
    public int? Height { get; init; }
    public int? ColorDepth { get; init; }
    public int? FrameRate { get; init; }
    public List<string>? Permissions { get; init; } // ["view", "control", "clipboard"]
}

/// <summary>
/// Remote session representation
/// </summary>
public record RemoteSessionDto
{
    public string Id { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public SessionType SessionType { get; init; }
    public string? UbiquitySessionId { get; init; }

    // Status
    public SessionStatus Status { get; init; }

    // Configuration
    public string? Resolution { get; init; }
    public int? ColorDepth { get; init; }
    public int? FrameRate { get; init; }
    public List<string> Permissions { get; init; } = new();

    // Streaming
    public string? StreamUrl { get; init; }
    public string? WebSocketUrl { get; init; }

    // Timing
    public DateTime? ConnectedAt { get; init; }
    public DateTime? DisconnectedAt { get; init; }
    public int? DurationSeconds { get; init; }

    // Error
    public string? DisconnectReason { get; init; }
    public string? ErrorMessage { get; init; }
}

/// <summary>
/// Input event for remote control
/// </summary>
public record InputEventRequest
{
    public required string SessionId { get; init; }
    public required InputEventType EventType { get; init; }

    // For keyboard events
    public string? Key { get; init; }
    public int? KeyCode { get; init; }
    public bool? ShiftKey { get; init; }
    public bool? CtrlKey { get; init; }
    public bool? AltKey { get; init; }

    // For mouse events
    public int? X { get; init; }
    public int? Y { get; init; }
    public int? Button { get; init; }
    public int? WheelDelta { get; init; }
}

/// <summary>
/// Input event type
/// </summary>
public enum InputEventType
{
    KeyDown,
    KeyUp,
    KeyPress,
    MouseMove,
    MouseDown,
    MouseUp,
    MouseClick,
    MouseDoubleClick,
    MouseWheel
}

/// <summary>
/// Process information
/// </summary>
public record ProcessInfoDto
{
    public int Pid { get; init; }
    public string Name { get; init; } = string.Empty;
    public string? CommandLine { get; init; }
    public string? User { get; init; }
    public double CpuPercent { get; init; }
    public long MemoryBytes { get; init; }
    public ProcessStatus Status { get; init; }
    public DateTime StartedAt { get; init; }
    public int? ParentPid { get; init; }
}

/// <summary>
/// Process status
/// </summary>
public enum ProcessStatus
{
    Running,
    Sleeping,
    Stopped,
    Zombie,
    Unknown
}

/// <summary>
/// Process action request
/// </summary>
public record ProcessActionRequest
{
    public required string DeviceId { get; init; }
    public int? Pid { get; init; }
    public string? ProcessName { get; init; }
    public ProcessAction Action { get; init; }
    public List<string>? Arguments { get; init; }
}

/// <summary>
/// Process action type
/// </summary>
public enum ProcessAction
{
    Start,
    Stop,
    Restart,
    Kill
}

/// <summary>
/// Process action result
/// </summary>
public record ProcessActionResultDto
{
    public bool Success { get; init; }
    public int? Pid { get; init; }
    public string? ProcessName { get; init; }
    public ProcessAction Action { get; init; }
    public string? ErrorMessage { get; init; }
    public DateTime ExecutedAt { get; init; }
}

/// <summary>
/// Process snapshot (point-in-time capture)
/// </summary>
public record ProcessSnapshotDto
{
    public string Id { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public List<ProcessInfoDto> Processes { get; init; } = new();
    public SystemMetricsDto SystemMetrics { get; init; } = new();
    public DateTime CapturedAt { get; init; }
}
