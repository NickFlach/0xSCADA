using System.Collections.Concurrent;
using UbiquityBridge.Models;

namespace UbiquityBridge.Services;

/// <summary>
/// Manages remote desktop sessions to Ubiquity devices
/// </summary>
public class RemoteDesktopService
{
    private readonly ILogger<RemoteDesktopService> _logger;
    private readonly UbiquityConnectionService _connectionService;
    private readonly DeviceService _deviceService;
    private readonly ConcurrentDictionary<string, RemoteSessionDto> _sessions = new();

    public RemoteDesktopService(
        ILogger<RemoteDesktopService> logger,
        UbiquityConnectionService connectionService,
        DeviceService deviceService)
    {
        _logger = logger;
        _connectionService = connectionService;
        _deviceService = deviceService;
    }

    /// <summary>
    /// Start a remote desktop session
    /// </summary>
    public async Task<RemoteSessionDto> StartSessionAsync(
        StartSessionRequest request,
        CancellationToken ct = default)
    {
        var device = _deviceService.GetDevice(request.DeviceId);
        if (device == null)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} not found");
        }

        if (!device.SupportsRemoteDesktop && request.SessionType == SessionType.RemoteDesktop)
        {
            throw new InvalidOperationException($"Device {request.DeviceId} does not support remote desktop");
        }

        var connection = _connectionService.GetConnection(device.DomainId);
        if (connection == null || connection.Status != ConnectionStatus.Online)
        {
            throw new InvalidOperationException($"Not connected to domain {device.DomainId}");
        }

        var sessionId = Guid.NewGuid().ToString();
        var width = request.Width ?? 1920;
        var height = request.Height ?? 1080;

        _logger.LogInformation(
            "Starting {SessionType} session {SessionId} for device {DeviceId}",
            request.SessionType, sessionId, request.DeviceId);

        var session = new RemoteSessionDto
        {
            Id = sessionId,
            DeviceId = request.DeviceId,
            SessionType = request.SessionType,
            Status = SessionStatus.Connecting,
            Resolution = $"{width}x{height}",
            ColorDepth = request.ColorDepth ?? 24,
            FrameRate = request.FrameRate ?? 30,
            Permissions = request.Permissions ?? new List<string> { "view" }
        };

        _sessions[sessionId] = session;

        // TODO: Replace with actual Ubiquity SDK session start
        // var ubiquitySession = await connection.Client.StartRemoteSessionAsync(
        //     device.UbiquityDeviceId,
        //     new SessionOptions { Width = width, Height = height });

        // Simulated session establishment
        await Task.Delay(500, ct); // Simulate connection time

        var ubiquitySessionId = $"ubq-session-{Guid.NewGuid():N}";
        session = session with
        {
            UbiquitySessionId = ubiquitySessionId,
            Status = SessionStatus.Connected,
            ConnectedAt = DateTime.UtcNow,
            StreamUrl = $"/api/ubiquity/sessions/{sessionId}/stream",
            WebSocketUrl = $"ws://localhost:8081/sessions/{sessionId}/ws"
        };

        _sessions[sessionId] = session;
        _logger.LogInformation("Session {SessionId} connected successfully", sessionId);

        return session;
    }

    /// <summary>
    /// End a remote session
    /// </summary>
    public async Task EndSessionAsync(string sessionId, string? reason = null, CancellationToken ct = default)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            throw new InvalidOperationException($"Session {sessionId} not found");
        }

        _logger.LogInformation("Ending session {SessionId}, reason: {Reason}", sessionId, reason ?? "user requested");

        // TODO: Replace with actual SDK session end
        // await connection.Client.EndRemoteSessionAsync(session.UbiquitySessionId);

        var connectedAt = session.ConnectedAt ?? DateTime.UtcNow;
        var duration = (int)(DateTime.UtcNow - connectedAt).TotalSeconds;

        session = session with
        {
            Status = SessionStatus.Disconnected,
            DisconnectedAt = DateTime.UtcNow,
            DurationSeconds = duration,
            DisconnectReason = reason
        };

        _sessions[sessionId] = session;
    }

    /// <summary>
    /// Get session details
    /// </summary>
    public RemoteSessionDto? GetSession(string sessionId)
    {
        _sessions.TryGetValue(sessionId, out var session);
        return session;
    }

    /// <summary>
    /// Get all active sessions
    /// </summary>
    public IEnumerable<RemoteSessionDto> GetActiveSessions(string? deviceId = null)
    {
        var sessions = _sessions.Values
            .Where(s => s.Status == SessionStatus.Connected || s.Status == SessionStatus.Connecting);

        if (!string.IsNullOrEmpty(deviceId))
        {
            sessions = sessions.Where(s => s.DeviceId == deviceId);
        }

        return sessions;
    }

    /// <summary>
    /// Get session history for a device
    /// </summary>
    public IEnumerable<RemoteSessionDto> GetSessionHistory(string deviceId, int limit = 50)
    {
        return _sessions.Values
            .Where(s => s.DeviceId == deviceId)
            .OrderByDescending(s => s.ConnectedAt ?? s.DisconnectedAt ?? DateTime.MinValue)
            .Take(limit);
    }

    /// <summary>
    /// Send input event to remote session
    /// </summary>
    public async Task SendInputEventAsync(InputEventRequest request, CancellationToken ct = default)
    {
        if (!_sessions.TryGetValue(request.SessionId, out var session))
        {
            throw new InvalidOperationException($"Session {request.SessionId} not found");
        }

        if (session.Status != SessionStatus.Connected)
        {
            throw new InvalidOperationException($"Session {request.SessionId} is not connected");
        }

        if (!session.Permissions.Contains("control"))
        {
            throw new UnauthorizedAccessException($"Session {request.SessionId} does not have control permission");
        }

        _logger.LogDebug(
            "Sending {EventType} to session {SessionId}",
            request.EventType, request.SessionId);

        // TODO: Replace with actual SDK input event
        // await connection.Client.SendInputEventAsync(session.UbiquitySessionId, new InputEvent
        // {
        //     Type = request.EventType,
        //     Key = request.Key,
        //     X = request.X,
        //     Y = request.Y,
        //     ...
        // });
    }

    /// <summary>
    /// Change session resolution
    /// </summary>
    public async Task SetResolutionAsync(string sessionId, int width, int height, CancellationToken ct = default)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
        {
            throw new InvalidOperationException($"Session {sessionId} not found");
        }

        _logger.LogInformation(
            "Changing resolution for session {SessionId} to {Width}x{Height}",
            sessionId, width, height);

        // TODO: Replace with actual SDK resolution change

        session = session with { Resolution = $"{width}x{height}" };
        _sessions[sessionId] = session;
    }

    /// <summary>
    /// Get stream URL for a session
    /// </summary>
    public string? GetStreamUrl(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session) && session.Status == SessionStatus.Connected)
        {
            return session.StreamUrl;
        }
        return null;
    }

    /// <summary>
    /// Clean up stale sessions
    /// </summary>
    public void CleanupStaleSessions(TimeSpan maxAge)
    {
        var cutoff = DateTime.UtcNow - maxAge;
        var staleSessionIds = _sessions
            .Where(kvp => kvp.Value.Status == SessionStatus.Disconnected &&
                          (kvp.Value.DisconnectedAt ?? DateTime.MinValue) < cutoff)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var sessionId in staleSessionIds)
        {
            _sessions.TryRemove(sessionId, out _);
        }

        if (staleSessionIds.Count > 0)
        {
            _logger.LogInformation("Cleaned up {Count} stale sessions", staleSessionIds.Count);
        }
    }
}
