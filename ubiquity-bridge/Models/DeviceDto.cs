namespace UbiquityBridge.Models;

/// <summary>
/// Ubiquity domain (cloud account) representation
/// </summary>
public record UbiquityDomainDto
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string CloudEndpoint { get; init; } = string.Empty;
    public string? TenantId { get; init; }
    public ConnectionStatus Status { get; init; }
    public DateTime? LastConnected { get; init; }
    public string? ErrorMessage { get; init; }
}

/// <summary>
/// Ubiquity device representation
/// </summary>
public record UbiquityDeviceDto
{
    public string Id { get; init; } = string.Empty;
    public string DomainId { get; init; } = string.Empty;
    public string UbiquityDeviceId { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string? DisplayName { get; init; }
    public string? Description { get; init; }

    // Device metadata
    public string? DeviceType { get; init; }
    public string? Model { get; init; }
    public string? SerialNumber { get; init; }
    public string? FirmwareVersion { get; init; }
    public string? OsVersion { get; init; }
    public string? MacAddress { get; init; }
    public string? IpAddress { get; init; }

    // Connectivity
    public ConnectionStatus ConnectionStatus { get; init; }
    public DateTime? LastSeen { get; init; }
    public int? SignalStrength { get; init; }

    // Capabilities
    public bool SupportsRemoteDesktop { get; init; }
    public bool SupportsFileTransfer { get; init; }
    public bool SupportsProcessMonitor { get; init; }

    // Additional metadata
    public Dictionary<string, object>? Metadata { get; init; }
}

/// <summary>
/// Device discovery result
/// </summary>
public record DeviceDiscoveryResultDto
{
    public int TotalDevices { get; init; }
    public int NewDevices { get; init; }
    public int UpdatedDevices { get; init; }
    public int RemovedDevices { get; init; }
    public List<UbiquityDeviceDto> Devices { get; init; } = new();
    public DateTime DiscoveredAt { get; init; }
}

/// <summary>
/// Connection status enum
/// </summary>
public enum ConnectionStatus
{
    Offline,
    Connecting,
    Online,
    Error,
    Maintenance
}

/// <summary>
/// Device status details
/// </summary>
public record DeviceStatusDto
{
    public string DeviceId { get; init; } = string.Empty;
    public ConnectionStatus Status { get; init; }
    public DateTime LastSeen { get; init; }
    public int? SignalStrength { get; init; }
    public SystemMetricsDto? SystemMetrics { get; init; }
    public string? ErrorMessage { get; init; }
}

/// <summary>
/// System metrics from device
/// </summary>
public record SystemMetricsDto
{
    public double CpuUsage { get; init; }
    public double MemoryUsage { get; init; }
    public long MemoryTotalMb { get; init; }
    public long MemoryAvailableMb { get; init; }
    public double DiskUsage { get; init; }
    public long NetworkUploadBytesPerSec { get; init; }
    public long NetworkDownloadBytesPerSec { get; init; }
    public DateTime CapturedAt { get; init; }
}

/// <summary>
/// Request to connect to a domain
/// </summary>
public record ConnectDomainRequest
{
    public required string CloudEndpoint { get; init; }
    public required string Username { get; init; }
    public required string Password { get; init; }
    public string? ApiKey { get; init; }
    public string? TenantId { get; init; }
}

/// <summary>
/// Response after successful connection
/// </summary>
public record ConnectDomainResponse
{
    public string DomainId { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public ConnectionStatus Status { get; init; }
    public DateTime ConnectedAt { get; init; }
    public int DeviceCount { get; init; }
}
