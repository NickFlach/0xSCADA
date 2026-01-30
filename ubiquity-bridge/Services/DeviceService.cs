using System.Collections.Concurrent;
using UbiquityBridge.Models;

namespace UbiquityBridge.Services;

/// <summary>
/// Manages Ubiquity device discovery, status tracking, and operations
/// </summary>
public class DeviceService
{
    private readonly ILogger<DeviceService> _logger;
    private readonly UbiquityConnectionService _connectionService;
    private readonly ConcurrentDictionary<string, UbiquityDeviceDto> _devices = new();
    private readonly ConcurrentDictionary<string, Timer> _statusPollers = new();

    public DeviceService(
        ILogger<DeviceService> logger,
        UbiquityConnectionService connectionService)
    {
        _logger = logger;
        _connectionService = connectionService;
    }

    /// <summary>
    /// Discover devices from a Ubiquity domain
    /// </summary>
    public async Task<DeviceDiscoveryResultDto> DiscoverDevicesAsync(
        string domainId,
        CancellationToken ct = default)
    {
        var connection = _connectionService.GetConnection(domainId);
        if (connection == null || connection.Status != ConnectionStatus.Online)
        {
            throw new InvalidOperationException($"Not connected to domain {domainId}");
        }

        _logger.LogInformation("Discovering devices for domain {DomainId}", domainId);

        // TODO: Replace with actual Ubiquity SDK calls
        // var ubiquityDevices = await connection.Client.GetDomainDevicesAsync();

        // Simulated device discovery for development
        var discoveredDevices = new List<UbiquityDeviceDto>
        {
            new()
            {
                Id = Guid.NewGuid().ToString(),
                DomainId = domainId,
                UbiquityDeviceId = "UBQ-001",
                Name = "ControlLogix-5580",
                DisplayName = "Main PLC Controller",
                DeviceType = "PLC",
                Model = "1756-L85E",
                SerialNumber = "SN-2024-001",
                FirmwareVersion = "33.011",
                IpAddress = "192.168.1.100",
                ConnectionStatus = ConnectionStatus.Online,
                LastSeen = DateTime.UtcNow,
                SupportsRemoteDesktop = false,
                SupportsFileTransfer = true,
                SupportsProcessMonitor = true
            },
            new()
            {
                Id = Guid.NewGuid().ToString(),
                DomainId = domainId,
                UbiquityDeviceId = "UBQ-002",
                Name = "PanelView-Plus-7",
                DisplayName = "Operator HMI",
                DeviceType = "HMI",
                Model = "2711P-T15C22D9P",
                SerialNumber = "SN-2024-002",
                FirmwareVersion = "12.0",
                IpAddress = "192.168.1.101",
                ConnectionStatus = ConnectionStatus.Online,
                LastSeen = DateTime.UtcNow,
                SupportsRemoteDesktop = true,
                SupportsFileTransfer = true,
                SupportsProcessMonitor = true
            }
        };

        var existingDeviceIds = _devices.Values
            .Where(d => d.DomainId == domainId)
            .Select(d => d.UbiquityDeviceId)
            .ToHashSet();

        var newCount = 0;
        var updatedCount = 0;

        foreach (var device in discoveredDevices)
        {
            if (existingDeviceIds.Contains(device.UbiquityDeviceId))
            {
                updatedCount++;
            }
            else
            {
                newCount++;
            }
            _devices[device.Id] = device;
        }

        connection.DeviceCount = discoveredDevices.Count;

        _logger.LogInformation(
            "Discovered {Total} devices ({New} new, {Updated} updated) for domain {DomainId}",
            discoveredDevices.Count, newCount, updatedCount, domainId);

        return new DeviceDiscoveryResultDto
        {
            TotalDevices = discoveredDevices.Count,
            NewDevices = newCount,
            UpdatedDevices = updatedCount,
            RemovedDevices = 0,
            Devices = discoveredDevices,
            DiscoveredAt = DateTime.UtcNow
        };
    }

    /// <summary>
    /// Get all devices for a domain
    /// </summary>
    public IEnumerable<UbiquityDeviceDto> GetDevices(string? domainId = null)
    {
        var devices = _devices.Values.AsEnumerable();
        if (!string.IsNullOrEmpty(domainId))
        {
            devices = devices.Where(d => d.DomainId == domainId);
        }
        return devices;
    }

    /// <summary>
    /// Get a specific device
    /// </summary>
    public UbiquityDeviceDto? GetDevice(string deviceId)
    {
        _devices.TryGetValue(deviceId, out var device);
        return device;
    }

    /// <summary>
    /// Get device status
    /// </summary>
    public async Task<DeviceStatusDto?> GetDeviceStatusAsync(
        string deviceId,
        CancellationToken ct = default)
    {
        if (!_devices.TryGetValue(deviceId, out var device))
        {
            return null;
        }

        var connection = _connectionService.GetConnection(device.DomainId);
        if (connection == null || connection.Status != ConnectionStatus.Online)
        {
            return new DeviceStatusDto
            {
                DeviceId = deviceId,
                Status = ConnectionStatus.Offline,
                LastSeen = device.LastSeen ?? DateTime.MinValue,
                ErrorMessage = "Domain not connected"
            };
        }

        // TODO: Replace with actual SDK status check
        // var status = await connection.Client.GetDeviceStatusAsync(device.UbiquityDeviceId);

        return new DeviceStatusDto
        {
            DeviceId = deviceId,
            Status = device.ConnectionStatus,
            LastSeen = device.LastSeen ?? DateTime.UtcNow,
            SignalStrength = device.SignalStrength,
            SystemMetrics = device.SupportsProcessMonitor ? new SystemMetricsDto
            {
                CpuUsage = Random.Shared.NextDouble() * 50 + 10,
                MemoryUsage = Random.Shared.NextDouble() * 40 + 30,
                MemoryTotalMb = 8192,
                MemoryAvailableMb = 4096,
                DiskUsage = Random.Shared.NextDouble() * 30 + 20,
                CapturedAt = DateTime.UtcNow
            } : null
        };
    }

    /// <summary>
    /// Start polling device status
    /// </summary>
    public void StartStatusPolling(string deviceId, int intervalMs = 30000)
    {
        if (_statusPollers.ContainsKey(deviceId))
        {
            _logger.LogWarning("Status polling already active for device {DeviceId}", deviceId);
            return;
        }

        var timer = new Timer(async _ =>
        {
            try
            {
                var status = await GetDeviceStatusAsync(deviceId);
                if (status != null && _devices.TryGetValue(deviceId, out var device))
                {
                    // Update device with latest status
                    _devices[deviceId] = device with
                    {
                        ConnectionStatus = status.Status,
                        LastSeen = status.LastSeen,
                        SignalStrength = status.SignalStrength
                    };
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error polling status for device {DeviceId}", deviceId);
            }
        }, null, 0, intervalMs);

        _statusPollers[deviceId] = timer;
        _logger.LogInformation("Started status polling for device {DeviceId} every {Interval}ms",
            deviceId, intervalMs);
    }

    /// <summary>
    /// Stop polling device status
    /// </summary>
    public void StopStatusPolling(string deviceId)
    {
        if (_statusPollers.TryRemove(deviceId, out var timer))
        {
            timer.Dispose();
            _logger.LogInformation("Stopped status polling for device {DeviceId}", deviceId);
        }
    }

    /// <summary>
    /// Update device metadata
    /// </summary>
    public UbiquityDeviceDto? UpdateDevice(string deviceId, Dictionary<string, object> updates)
    {
        if (!_devices.TryGetValue(deviceId, out var device))
        {
            return null;
        }

        // Apply updates
        var updatedDevice = device with
        {
            DisplayName = updates.TryGetValue("displayName", out var dn) ? dn?.ToString() : device.DisplayName,
            Description = updates.TryGetValue("description", out var desc) ? desc?.ToString() : device.Description,
            Metadata = updates.TryGetValue("metadata", out var meta) && meta is Dictionary<string, object> metaDict
                ? metaDict
                : device.Metadata
        };

        _devices[deviceId] = updatedDevice;
        return updatedDevice;
    }

    /// <summary>
    /// Remove a device from tracking
    /// </summary>
    public bool RemoveDevice(string deviceId)
    {
        StopStatusPolling(deviceId);
        return _devices.TryRemove(deviceId, out _);
    }
}
