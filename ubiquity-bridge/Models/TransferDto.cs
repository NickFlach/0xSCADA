namespace UbiquityBridge.Models;

/// <summary>
/// File transfer request
/// </summary>
public record FileTransferRequest
{
    public required string DeviceId { get; init; }
    public required string LocalPath { get; init; }
    public required string RemotePath { get; init; }
    public TransferDirection Direction { get; init; }
    public bool Overwrite { get; init; } = false;
}

/// <summary>
/// File transfer direction
/// </summary>
public enum TransferDirection
{
    Upload,
    Download
}

/// <summary>
/// File transfer status
/// </summary>
public enum TransferStatus
{
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled
}

/// <summary>
/// File transfer response/status
/// </summary>
public record FileTransferDto
{
    public string Id { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public TransferDirection Direction { get; init; }
    public string LocalPath { get; init; } = string.Empty;
    public string RemotePath { get; init; } = string.Empty;
    public string FileName { get; init; } = string.Empty;
    public long? FileSize { get; init; }
    public string? FileHash { get; init; }
    public string? ContentType { get; init; }

    // Progress
    public TransferStatus Status { get; init; }
    public int Progress { get; init; }
    public long BytesTransferred { get; init; }
    public double? TransferRateBytesPerSec { get; init; }
    public TimeSpan? EstimatedTimeRemaining { get; init; }

    // Error info
    public string? ErrorMessage { get; init; }

    // Timing
    public DateTime? StartedAt { get; init; }
    public DateTime? CompletedAt { get; init; }
}

/// <summary>
/// Firmware deployment request
/// </summary>
public record FirmwareDeploymentRequest
{
    public required string DeviceId { get; init; }
    public required string FirmwarePath { get; init; }
    public required string Version { get; init; }
    public bool ForceUpdate { get; init; } = false;
    public bool RebootAfterInstall { get; init; } = true;
}

/// <summary>
/// Firmware deployment result
/// </summary>
public record FirmwareDeploymentDto
{
    public string Id { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public string Version { get; init; } = string.Empty;
    public string PreviousVersion { get; init; } = string.Empty;
    public DeploymentStatus Status { get; init; }
    public int Progress { get; init; }
    public string? ErrorMessage { get; init; }
    public DateTime StartedAt { get; init; }
    public DateTime? CompletedAt { get; init; }
}

/// <summary>
/// Firmware deployment status
/// </summary>
public enum DeploymentStatus
{
    Pending,
    Uploading,
    Installing,
    Rebooting,
    Verifying,
    Completed,
    Failed,
    RolledBack
}

/// <summary>
/// File listing entry
/// </summary>
public record RemoteFileDto
{
    public string Name { get; init; } = string.Empty;
    public string Path { get; init; } = string.Empty;
    public bool IsDirectory { get; init; }
    public long? Size { get; init; }
    public DateTime? ModifiedAt { get; init; }
    public string? Permissions { get; init; }
}

/// <summary>
/// Directory listing request
/// </summary>
public record ListDirectoryRequest
{
    public required string DeviceId { get; init; }
    public required string Path { get; init; }
    public bool Recursive { get; init; } = false;
}
