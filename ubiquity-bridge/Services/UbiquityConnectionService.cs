using System.Collections.Concurrent;
using UbiquityBridge.Models;

namespace UbiquityBridge.Services;

/// <summary>
/// Manages connections to Ubiquity cloud domains
/// Handles authentication, connection pooling, and session management
/// </summary>
public class UbiquityConnectionService : IDisposable
{
    private readonly ILogger<UbiquityConnectionService> _logger;
    private readonly IConfiguration _configuration;
    private readonly ConcurrentDictionary<string, UbiquityConnection> _connections = new();
    private readonly SemaphoreSlim _connectionLock = new(1, 1);
    private bool _disposed;

    public UbiquityConnectionService(
        ILogger<UbiquityConnectionService> logger,
        IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;
    }

    /// <summary>
    /// Connect to a Ubiquity domain
    /// </summary>
    public async Task<ConnectDomainResponse> ConnectAsync(ConnectDomainRequest request, CancellationToken ct = default)
    {
        await _connectionLock.WaitAsync(ct);
        try
        {
            var domainId = GenerateDomainId(request.CloudEndpoint, request.Username);

            if (_connections.TryGetValue(domainId, out var existing) && existing.Status == ConnectionStatus.Online)
            {
                _logger.LogInformation("Reusing existing connection for domain {DomainId}", domainId);
                return new ConnectDomainResponse
                {
                    DomainId = domainId,
                    Name = existing.Name,
                    Status = existing.Status,
                    ConnectedAt = existing.ConnectedAt,
                    DeviceCount = existing.DeviceCount
                };
            }

            _logger.LogInformation("Connecting to Ubiquity domain at {Endpoint}", request.CloudEndpoint);

            // TODO: Replace with actual Ubiquity SDK calls
            // var client = new Asem.Ubiquity.SDK.UbiquityClient();
            // await client.AuthenticateAsync(request.Username, request.Password);

            // Simulated connection for development
            var connection = new UbiquityConnection
            {
                Id = domainId,
                Name = $"Domain-{request.TenantId ?? "default"}",
                CloudEndpoint = request.CloudEndpoint,
                TenantId = request.TenantId,
                Username = request.Username,
                Status = ConnectionStatus.Online,
                ConnectedAt = DateTime.UtcNow,
                DeviceCount = 0 // Will be populated after device discovery
            };

            _connections[domainId] = connection;

            _logger.LogInformation("Successfully connected to domain {DomainId}", domainId);

            return new ConnectDomainResponse
            {
                DomainId = connection.Id,
                Name = connection.Name,
                Status = connection.Status,
                ConnectedAt = connection.ConnectedAt,
                DeviceCount = connection.DeviceCount
            };
        }
        finally
        {
            _connectionLock.Release();
        }
    }

    /// <summary>
    /// Disconnect from a Ubiquity domain
    /// </summary>
    public async Task DisconnectAsync(string domainId, CancellationToken ct = default)
    {
        if (_connections.TryRemove(domainId, out var connection))
        {
            _logger.LogInformation("Disconnecting from domain {DomainId}", domainId);

            // TODO: Replace with actual SDK disconnect
            // connection.Client?.Dispose();

            connection.Status = ConnectionStatus.Offline;
            connection.DisconnectedAt = DateTime.UtcNow;
        }
    }

    /// <summary>
    /// Get connection for a domain
    /// </summary>
    public UbiquityConnection? GetConnection(string domainId)
    {
        _connections.TryGetValue(domainId, out var connection);
        return connection;
    }

    /// <summary>
    /// Get all active connections
    /// </summary>
    public IEnumerable<UbiquityConnection> GetAllConnections()
    {
        return _connections.Values.Where(c => c.Status == ConnectionStatus.Online);
    }

    /// <summary>
    /// Check if connected to a domain
    /// </summary>
    public bool IsConnected(string domainId)
    {
        return _connections.TryGetValue(domainId, out var connection)
               && connection.Status == ConnectionStatus.Online;
    }

    /// <summary>
    /// Get domain status
    /// </summary>
    public UbiquityDomainDto? GetDomainStatus(string domainId)
    {
        if (!_connections.TryGetValue(domainId, out var connection))
            return null;

        return new UbiquityDomainDto
        {
            Id = connection.Id,
            Name = connection.Name,
            CloudEndpoint = connection.CloudEndpoint,
            TenantId = connection.TenantId,
            Status = connection.Status,
            LastConnected = connection.ConnectedAt,
            ErrorMessage = connection.ErrorMessage
        };
    }

    /// <summary>
    /// Refresh connection (re-authenticate if needed)
    /// </summary>
    public async Task RefreshConnectionAsync(string domainId, CancellationToken ct = default)
    {
        if (!_connections.TryGetValue(domainId, out var connection))
        {
            throw new InvalidOperationException($"No connection found for domain {domainId}");
        }

        _logger.LogInformation("Refreshing connection for domain {DomainId}", domainId);

        // TODO: Implement token refresh logic with Ubiquity SDK
        // await connection.Client.RefreshTokenAsync();

        connection.LastRefreshed = DateTime.UtcNow;
    }

    private static string GenerateDomainId(string endpoint, string username)
    {
        var input = $"{endpoint}:{username}";
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(hash)[..16].ToLowerInvariant();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var connection in _connections.Values)
        {
            // Dispose SDK clients
        }
        _connections.Clear();
        _connectionLock.Dispose();
    }
}

/// <summary>
/// Internal connection state
/// </summary>
public class UbiquityConnection
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string CloudEndpoint { get; set; } = string.Empty;
    public string? TenantId { get; set; }
    public string Username { get; set; } = string.Empty;
    public ConnectionStatus Status { get; set; }
    public DateTime ConnectedAt { get; set; }
    public DateTime? DisconnectedAt { get; set; }
    public DateTime? LastRefreshed { get; set; }
    public int DeviceCount { get; set; }
    public string? ErrorMessage { get; set; }

    // TODO: Add actual SDK client reference
    // public Asem.Ubiquity.SDK.UbiquityClient? Client { get; set; }
}
