using System.Collections.Concurrent;
using System.Security.Cryptography;
using UbiquityBridge.Models;

namespace UbiquityBridge.Services;

/// <summary>
/// Manages file transfers to/from Ubiquity devices
/// </summary>
public class FileTransferService
{
    private readonly ILogger<FileTransferService> _logger;
    private readonly UbiquityConnectionService _connectionService;
    private readonly DeviceService _deviceService;
    private readonly ConcurrentDictionary<string, FileTransferDto> _transfers = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _transferCancellations = new();

    public FileTransferService(
        ILogger<FileTransferService> logger,
        UbiquityConnectionService connectionService,
        DeviceService deviceService)
    {
        _logger = logger;
        _connectionService = connectionService;
        _deviceService = deviceService;
    }

    /// <summary>
    /// Upload a file to a device
    /// </summary>
    public async Task<FileTransferDto> UploadFileAsync(
        FileTransferRequest request,
        IProgress<int>? progress = null,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        if (!device.SupportsFileTransfer)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} does not support file transfer");
        }

        var connection = _connectionService.GetConnection(device.DomainId);
        if (connection == null || connection.Status != ConnectionStatus.Online)
        {
            throw new InvalidOperationException($"Not connected to domain {device.DomainId}");
        }

        var transferId = Guid.NewGuid().ToString();
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _transferCancellations[transferId] = cts;

        var fileInfo = new FileInfo(request.LocalPath);
        if (!fileInfo.Exists)
        {
            throw new FileNotFoundException($"Local file not found: {request.LocalPath}");
        }

        var transfer = new FileTransferDto
        {
            Id = transferId,
            DeviceId = request.DeviceId,
            Direction = TransferDirection.Upload,
            LocalPath = request.LocalPath,
            RemotePath = request.RemotePath,
            FileName = fileInfo.Name,
            FileSize = fileInfo.Length,
            ContentType = GetContentType(fileInfo.Extension),
            Status = TransferStatus.Pending,
            Progress = 0,
            BytesTransferred = 0
        };

        _transfers[transferId] = transfer;
        _logger.LogInformation(
            "Starting upload {TransferId}: {LocalPath} -> {DeviceId}:{RemotePath}",
            transferId, request.LocalPath, request.DeviceId, request.RemotePath);

        // Start transfer in background
        _ = Task.Run(async () =>
        {
            try
            {
                transfer = transfer with { Status = TransferStatus.InProgress, StartedAt = DateTime.UtcNow };
                _transfers[transferId] = transfer;

                // Calculate file hash
                var hash = await ComputeFileHashAsync(request.LocalPath, cts.Token);

                // TODO: Replace with actual Ubiquity SDK file upload
                // await connection.Client.UploadFileAsync(
                //     device.UbiquityDeviceId,
                //     request.LocalPath,
                //     request.RemotePath,
                //     new Progress<long>(bytes => { ... }),
                //     cts.Token);

                // Simulated upload with progress
                var totalBytes = fileInfo.Length;
                var chunkSize = Math.Min(totalBytes / 10, 1024 * 1024); // Max 1MB chunks
                for (long transferred = 0; transferred < totalBytes && !cts.Token.IsCancellationRequested; )
                {
                    await Task.Delay(100, cts.Token); // Simulate transfer time
                    transferred = Math.Min(transferred + chunkSize, totalBytes);
                    var progressPercent = (int)((transferred * 100) / totalBytes);

                    transfer = transfer with
                    {
                        Progress = progressPercent,
                        BytesTransferred = transferred,
                        TransferRateBytesPerSec = chunkSize * 10 // Approximate
                    };
                    _transfers[transferId] = transfer;
                    progress?.Report(progressPercent);
                }

                transfer = transfer with
                {
                    Status = TransferStatus.Completed,
                    Progress = 100,
                    BytesTransferred = totalBytes,
                    FileHash = hash,
                    CompletedAt = DateTime.UtcNow
                };
                _transfers[transferId] = transfer;

                _logger.LogInformation("Upload {TransferId} completed successfully", transferId);
            }
            catch (OperationCanceledException)
            {
                transfer = transfer with { Status = TransferStatus.Cancelled };
                _transfers[transferId] = transfer;
                _logger.LogInformation("Upload {TransferId} was cancelled", transferId);
            }
            catch (Exception ex)
            {
                transfer = transfer with
                {
                    Status = TransferStatus.Failed,
                    ErrorMessage = ex.Message
                };
                _transfers[transferId] = transfer;
                _logger.LogError(ex, "Upload {TransferId} failed", transferId);
            }
            finally
            {
                _transferCancellations.TryRemove(transferId, out _);
            }
        }, CancellationToken.None);

        return transfer;
    }

    /// <summary>
    /// Download a file from a device
    /// </summary>
    public async Task<FileTransferDto> DownloadFileAsync(
        FileTransferRequest request,
        IProgress<int>? progress = null,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        if (!device.SupportsFileTransfer)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} does not support file transfer");
        }

        var transferId = Guid.NewGuid().ToString();
        var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _transferCancellations[transferId] = cts;

        var transfer = new FileTransferDto
        {
            Id = transferId,
            DeviceId = request.DeviceId,
            Direction = TransferDirection.Download,
            LocalPath = request.LocalPath,
            RemotePath = request.RemotePath,
            FileName = Path.GetFileName(request.RemotePath),
            Status = TransferStatus.Pending,
            Progress = 0,
            BytesTransferred = 0
        };

        _transfers[transferId] = transfer;
        _logger.LogInformation(
            "Starting download {TransferId}: {DeviceId}:{RemotePath} -> {LocalPath}",
            transferId, request.DeviceId, request.RemotePath, request.LocalPath);

        // Start transfer in background (similar pattern to upload)
        _ = Task.Run(async () =>
        {
            try
            {
                transfer = transfer with { Status = TransferStatus.InProgress, StartedAt = DateTime.UtcNow };
                _transfers[transferId] = transfer;

                // TODO: Replace with actual Ubiquity SDK file download
                // Simulated download
                var totalBytes = 1024 * 1024L; // Assume 1MB file
                await SimulateTransferAsync(transferId, totalBytes, progress, cts.Token);

                transfer = _transfers[transferId] with
                {
                    Status = TransferStatus.Completed,
                    Progress = 100,
                    CompletedAt = DateTime.UtcNow
                };
                _transfers[transferId] = transfer;

                _logger.LogInformation("Download {TransferId} completed successfully", transferId);
            }
            catch (OperationCanceledException)
            {
                transfer = _transfers[transferId] with { Status = TransferStatus.Cancelled };
                _transfers[transferId] = transfer;
            }
            catch (Exception ex)
            {
                transfer = _transfers[transferId] with
                {
                    Status = TransferStatus.Failed,
                    ErrorMessage = ex.Message
                };
                _transfers[transferId] = transfer;
                _logger.LogError(ex, "Download {TransferId} failed", transferId);
            }
            finally
            {
                _transferCancellations.TryRemove(transferId, out _);
            }
        }, CancellationToken.None);

        return transfer;
    }

    /// <summary>
    /// Get transfer status
    /// </summary>
    public FileTransferDto? GetTransfer(string transferId)
    {
        _transfers.TryGetValue(transferId, out var transfer);
        return transfer;
    }

    /// <summary>
    /// Get all transfers
    /// </summary>
    public IEnumerable<FileTransferDto> GetTransfers(string? deviceId = null)
    {
        var transfers = _transfers.Values.AsEnumerable();
        if (!string.IsNullOrEmpty(deviceId))
        {
            transfers = transfers.Where(t => t.DeviceId == deviceId);
        }
        return transfers.OrderByDescending(t => t.StartedAt);
    }

    /// <summary>
    /// Cancel a transfer
    /// </summary>
    public bool CancelTransfer(string transferId)
    {
        if (_transferCancellations.TryGetValue(transferId, out var cts))
        {
            cts.Cancel();
            _logger.LogInformation("Cancellation requested for transfer {TransferId}", transferId);
            return true;
        }
        return false;
    }

    /// <summary>
    /// Deploy firmware to a device
    /// </summary>
    public async Task<FirmwareDeploymentDto> DeployFirmwareAsync(
        FirmwareDeploymentRequest request,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        _logger.LogInformation(
            "Starting firmware deployment to {DeviceId}: version {Version}",
            request.DeviceId, request.Version);

        var deployment = new FirmwareDeploymentDto
        {
            Id = Guid.NewGuid().ToString(),
            DeviceId = request.DeviceId,
            Version = request.Version,
            PreviousVersion = device.FirmwareVersion ?? "unknown",
            Status = DeploymentStatus.Pending,
            Progress = 0,
            StartedAt = DateTime.UtcNow
        };

        // TODO: Implement actual firmware deployment with SDK
        // This would involve:
        // 1. Upload firmware file
        // 2. Verify firmware integrity
        // 3. Trigger installation
        // 4. Monitor installation progress
        // 5. Optionally reboot device
        // 6. Verify new firmware version

        return deployment;
    }

    /// <summary>
    /// List remote directory contents
    /// </summary>
    public async Task<IEnumerable<RemoteFileDto>> ListDirectoryAsync(
        ListDirectoryRequest request,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        // TODO: Replace with actual SDK directory listing
        // Simulated response
        return new List<RemoteFileDto>
        {
            new() { Name = "config.xml", Path = $"{request.Path}/config.xml", IsDirectory = false, Size = 4096 },
            new() { Name = "logs", Path = $"{request.Path}/logs", IsDirectory = true },
            new() { Name = "firmware", Path = $"{request.Path}/firmware", IsDirectory = true }
        };
    }

    private async Task SimulateTransferAsync(
        string transferId,
        long totalBytes,
        IProgress<int>? progress,
        CancellationToken ct)
    {
        var chunkSize = Math.Max(totalBytes / 20, 1024);
        for (long transferred = 0; transferred < totalBytes && !ct.IsCancellationRequested; )
        {
            await Task.Delay(50, ct);
            transferred = Math.Min(transferred + chunkSize, totalBytes);
            var progressPercent = (int)((transferred * 100) / totalBytes);

            if (_transfers.TryGetValue(transferId, out var transfer))
            {
                _transfers[transferId] = transfer with
                {
                    Progress = progressPercent,
                    BytesTransferred = transferred
                };
            }
            progress?.Report(progressPercent);
        }
    }

    private static async Task<string> ComputeFileHashAsync(string filePath, CancellationToken ct)
    {
        using var sha256 = SHA256.Create();
        await using var stream = File.OpenRead(filePath);
        var hash = await sha256.ComputeHashAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string GetContentType(string extension) => extension.ToLowerInvariant() switch
    {
        ".xml" => "application/xml",
        ".json" => "application/json",
        ".bin" => "application/octet-stream",
        ".txt" => "text/plain",
        ".l5x" => "application/xml",
        ".acd" => "application/octet-stream",
        _ => "application/octet-stream"
    };
}
