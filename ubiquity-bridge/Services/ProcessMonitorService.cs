using System.Collections.Concurrent;
using UbiquityBridge.Models;

namespace UbiquityBridge.Services;

/// <summary>
/// Monitors and manages processes on Ubiquity devices
/// </summary>
public class ProcessMonitorService
{
    private readonly ILogger<ProcessMonitorService> _logger;
    private readonly UbiquityConnectionService _connectionService;
    private readonly DeviceService _deviceService;
    private readonly ConcurrentDictionary<string, ProcessSnapshotDto> _latestSnapshots = new();
    private readonly ConcurrentDictionary<string, Timer> _monitoringTimers = new();

    public ProcessMonitorService(
        ILogger<ProcessMonitorService> logger,
        UbiquityConnectionService connectionService,
        DeviceService deviceService)
    {
        _logger = logger;
        _connectionService = connectionService;
        _deviceService = deviceService;
    }

    /// <summary>
    /// Get system metrics for a device
    /// </summary>
    public async Task<SystemMetricsDto?> GetSystemMetricsAsync(
        string deviceId,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(deviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {deviceId} not found");
        }

        if (!device.SupportsProcessMonitor)
        {
            throw new InvalidOperationException($"Device {deviceId} does not support process monitoring");
        }

        var connection = _connectionService.GetConnection(device.DomainId);
        if (connection == null || connection.Status != ConnectionStatus.Online)
        {
            throw new InvalidOperationException($"Not connected to domain {device.DomainId}");
        }

        // TODO: Replace with actual Ubiquity SDK metrics call
        // var metrics = await connection.Client.GetSystemMetricsAsync(device.UbiquityDeviceId);

        // Simulated metrics
        return new SystemMetricsDto
        {
            CpuUsage = Random.Shared.NextDouble() * 60 + 10,
            MemoryUsage = Random.Shared.NextDouble() * 40 + 30,
            MemoryTotalMb = 8192,
            MemoryAvailableMb = (long)(8192 * (1 - (Random.Shared.NextDouble() * 0.4 + 0.3))),
            DiskUsage = Random.Shared.NextDouble() * 30 + 20,
            NetworkUploadBytesPerSec = Random.Shared.Next(10000, 500000),
            NetworkDownloadBytesPerSec = Random.Shared.Next(50000, 2000000),
            CapturedAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Get process list for a device
    /// </summary>
    public async Task<IEnumerable<ProcessInfoDto>> GetProcessListAsync(
        string deviceId,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(deviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {deviceId} not found");
        }

        if (!device.SupportsProcessMonitor)
        {
            throw new InvalidOperationException($"Device {deviceId} does not support process monitoring");
        }

        // TODO: Replace with actual Ubiquity SDK process list
        // var processes = await connection.Client.GetProcessListAsync(device.UbiquityDeviceId);

        // Simulated process list for industrial controller
        return new List<ProcessInfoDto>
        {
            new()
            {
                Pid = 1,
                Name = "init",
                User = "root",
                CpuPercent = 0.1,
                MemoryBytes = 4 * 1024 * 1024,
                Status = ProcessStatus.Running,
                StartedAt = DateTime.UtcNow.AddDays(-30)
            },
            new()
            {
                Pid = 100,
                Name = "RSLinxNG",
                CommandLine = "/opt/rockwell/rslinx/RSLinxNG --daemon",
                User = "rockwell",
                CpuPercent = 5.2,
                MemoryBytes = 128 * 1024 * 1024,
                Status = ProcessStatus.Running,
                StartedAt = DateTime.UtcNow.AddDays(-7)
            },
            new()
            {
                Pid = 101,
                Name = "FactoryTalkLinx",
                CommandLine = "/opt/rockwell/ftlinx/FTLinx",
                User = "rockwell",
                CpuPercent = 8.4,
                MemoryBytes = 256 * 1024 * 1024,
                Status = ProcessStatus.Running,
                StartedAt = DateTime.UtcNow.AddDays(-7)
            },
            new()
            {
                Pid = 200,
                Name = "PLCEngine",
                CommandLine = "/opt/rockwell/plc/PLCEngine --project Main.acd",
                User = "rockwell",
                CpuPercent = 25.0,
                MemoryBytes = 512 * 1024 * 1024,
                Status = ProcessStatus.Running,
                StartedAt = DateTime.UtcNow.AddDays(-1)
            },
            new()
            {
                Pid = 300,
                Name = "UbiquityAgent",
                CommandLine = "/opt/asem/ubiquity/UbiquityAgent",
                User = "asem",
                CpuPercent = 2.1,
                MemoryBytes = 64 * 1024 * 1024,
                Status = ProcessStatus.Running,
                StartedAt = DateTime.UtcNow.AddDays(-30)
            }
        };
    }

    /// <summary>
    /// Start a process on a device
    /// </summary>
    public async Task<ProcessActionResultDto> StartProcessAsync(
        ProcessActionRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(request.ProcessName))
        {
            throw new ArgumentException("Process name is required for start action");
        }

        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        _logger.LogInformation(
            "Starting process {ProcessName} on device {DeviceId}",
            request.ProcessName, request.DeviceId);

        // TODO: Replace with actual SDK process start
        // var result = await connection.Client.StartProcessAsync(
        //     device.UbiquityDeviceId, request.ProcessName, request.Arguments);

        return new ProcessActionResultDto
        {
            Success = true,
            Pid = Random.Shared.Next(1000, 9999),
            ProcessName = request.ProcessName,
            Action = ProcessAction.Start,
            ExecutedAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Stop a process on a device
    /// </summary>
    public async Task<ProcessActionResultDto> StopProcessAsync(
        ProcessActionRequest request,
        CancellationToken ct = default)
    {
        if (!request.Pid.HasValue)
        {
            throw new ArgumentException("PID is required for stop action");
        }

        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        _logger.LogInformation(
            "Stopping process {Pid} on device {DeviceId}",
            request.Pid, request.DeviceId);

        // TODO: Replace with actual SDK process stop

        return new ProcessActionResultDto
        {
            Success = true,
            Pid = request.Pid,
            Action = ProcessAction.Stop,
            ExecutedAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Restart a process on a device
    /// </summary>
    public async Task<ProcessActionResultDto> RestartProcessAsync(
        ProcessActionRequest request,
        CancellationToken ct = default)
    {
        if (!request.Pid.HasValue)
        {
            throw new ArgumentException("PID is required for restart action");
        }

        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        _logger.LogInformation(
            "Restarting process {Pid} on device {DeviceId}",
            request.Pid, request.DeviceId);

        // TODO: Replace with actual SDK process restart

        return new ProcessActionResultDto
        {
            Success = true,
            Pid = Random.Shared.Next(1000, 9999), // New PID after restart
            Action = ProcessAction.Restart,
            ExecutedAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Capture a process snapshot for a device
    /// </summary>
    public async Task<ProcessSnapshotDto> CaptureSnapshotAsync(
        string deviceId,
        CancellationToken ct = default)
    {
        var processes = await GetProcessListAsync(deviceId, ct);
        var metrics = await GetSystemMetricsAsync(deviceId, ct);

        var snapshot = new ProcessSnapshotDto
        {
            Id = Guid.NewGuid().ToString(),
            DeviceId = deviceId,
            Processes = processes.ToList(),
            SystemMetrics = metrics ?? new SystemMetricsDto(),
            CapturedAt = DateTime.UtcNow
        };

        _latestSnapshots[deviceId] = snapshot;
        _logger.LogInformation(
            "Captured snapshot for device {DeviceId}: {ProcessCount} processes",
            deviceId, snapshot.Processes.Count);

        return snapshot;
    }

    /// <summary>
    /// Get the latest snapshot for a device
    /// </summary>
    public ProcessSnapshotDto? GetLatestSnapshot(string deviceId)
    {
        _latestSnapshots.TryGetValue(deviceId, out var snapshot);
        return snapshot;
    }

    /// <summary>
    /// Start continuous monitoring for a device
    /// </summary>
    public void StartMonitoring(string deviceId, int intervalMs = 30000)
    {
        if (_monitoringTimers.ContainsKey(deviceId))
        {
            _logger.LogWarning("Monitoring already active for device {DeviceId}", deviceId);
            return;
        }

        var timer = new Timer(async _ =>
        {
            try
            {
                await CaptureSnapshotAsync(deviceId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error capturing snapshot for device {DeviceId}", deviceId);
            }
        }, null, 0, intervalMs);

        _monitoringTimers[deviceId] = timer;
        _logger.LogInformation(
            "Started process monitoring for device {DeviceId} every {Interval}ms",
            deviceId, intervalMs);
    }

    /// <summary>
    /// Stop continuous monitoring for a device
    /// </summary>
    public void StopMonitoring(string deviceId)
    {
        if (_monitoringTimers.TryRemove(deviceId, out var timer))
        {
            timer.Dispose();
            _logger.LogInformation("Stopped process monitoring for device {DeviceId}", deviceId);
        }
    }
}
