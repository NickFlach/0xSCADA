using Serilog;
using UbiquityBridge.Models;
using UbiquityBridge.Services;

var builder = WebApplication.CreateBuilder(args);

// Configure Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .WriteTo.Console()
    .CreateLogger();

builder.Host.UseSerilog();

// Register services
builder.Services.AddSingleton<UbiquityConnectionService>();
builder.Services.AddSingleton<DeviceService>();
builder.Services.AddSingleton<FileTransferService>();
builder.Services.AddSingleton<RemoteDesktopService>();
builder.Services.AddSingleton<ProcessMonitorService>();

// Add Swagger
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new() { Title = "Ubiquity Bridge API", Version = "v1" });
});

// Add CORS
builder.Services.AddCors(options =>
{
    var origins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(origins)
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

// Add health checks
builder.Services.AddHealthChecks();

var app = builder.Build();

// Configure middleware
app.UseSerilogRequestLogging();
app.UseCors();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

// Health check endpoint
app.MapHealthChecks("/health");

// ============================================================================
// DOMAIN ENDPOINTS
// ============================================================================

var domains = app.MapGroup("/api/domains").WithTags("Domains");

domains.MapPost("/connect", async (
    ConnectDomainRequest request,
    UbiquityConnectionService connectionService,
    CancellationToken ct) =>
{
    try
    {
        var result = await connectionService.ConnectAsync(request, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("ConnectDomain")
.WithDescription("Connect to a Ubiquity cloud domain");

domains.MapPost("/{domainId}/disconnect", async (
    string domainId,
    UbiquityConnectionService connectionService,
    CancellationToken ct) =>
{
    await connectionService.DisconnectAsync(domainId, ct);
    return Results.Ok(new { message = "Disconnected successfully" });
})
.WithName("DisconnectDomain")
.WithDescription("Disconnect from a Ubiquity domain");

domains.MapGet("/{domainId}/status", (
    string domainId,
    UbiquityConnectionService connectionService) =>
{
    var status = connectionService.GetDomainStatus(domainId);
    return status != null ? Results.Ok(status) : Results.NotFound();
})
.WithName("GetDomainStatus")
.WithDescription("Get domain connection status");

domains.MapGet("/", (UbiquityConnectionService connectionService) =>
{
    var connections = connectionService.GetAllConnections()
        .Select(c => connectionService.GetDomainStatus(c.Id));
    return Results.Ok(connections);
})
.WithName("ListDomains")
.WithDescription("List all connected domains");

// ============================================================================
// DEVICE ENDPOINTS
// ============================================================================

var devices = app.MapGroup("/api/devices").WithTags("Devices");

devices.MapPost("/discover/{domainId}", async (
    string domainId,
    DeviceService deviceService,
    CancellationToken ct) =>
{
    try
    {
        var result = await deviceService.DiscoverDevicesAsync(domainId, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("DiscoverDevices")
.WithDescription("Discover devices from a Ubiquity domain");

devices.MapGet("/", (string? domainId, DeviceService deviceService) =>
{
    var deviceList = deviceService.GetDevices(domainId);
    return Results.Ok(deviceList);
})
.WithName("ListDevices")
.WithDescription("List all tracked devices");

devices.MapGet("/{deviceId}", (string deviceId, DeviceService deviceService) =>
{
    var device = deviceService.GetDevice(deviceId);
    return device != null ? Results.Ok(device) : Results.NotFound();
})
.WithName("GetDevice")
.WithDescription("Get device details");

devices.MapGet("/{deviceId}/status", async (
    string deviceId,
    DeviceService deviceService,
    CancellationToken ct) =>
{
    try
    {
        var status = await deviceService.GetDeviceStatusAsync(deviceId, ct);
        return status != null ? Results.Ok(status) : Results.NotFound();
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("GetDeviceStatus")
.WithDescription("Get real-time device status");

devices.MapPut("/{deviceId}", (
    string deviceId,
    Dictionary<string, object> updates,
    DeviceService deviceService) =>
{
    var device = deviceService.UpdateDevice(deviceId, updates);
    return device != null ? Results.Ok(device) : Results.NotFound();
})
.WithName("UpdateDevice")
.WithDescription("Update device metadata");

devices.MapDelete("/{deviceId}", (string deviceId, DeviceService deviceService) =>
{
    var removed = deviceService.RemoveDevice(deviceId);
    return removed ? Results.Ok() : Results.NotFound();
})
.WithName("RemoveDevice")
.WithDescription("Remove device from tracking");

// ============================================================================
// FILE TRANSFER ENDPOINTS
// ============================================================================

var files = app.MapGroup("/api/files").WithTags("File Transfer");

files.MapPost("/upload", async (
    FileTransferRequest request,
    FileTransferService fileTransferService,
    CancellationToken ct) =>
{
    try
    {
        var transfer = await fileTransferService.UploadFileAsync(request, null, ct);
        return Results.Accepted($"/api/files/transfers/{transfer.Id}", transfer);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("UploadFile")
.WithDescription("Upload a file to a device");

files.MapPost("/download", async (
    FileTransferRequest request,
    FileTransferService fileTransferService,
    CancellationToken ct) =>
{
    try
    {
        var transfer = await fileTransferService.DownloadFileAsync(request, null, ct);
        return Results.Accepted($"/api/files/transfers/{transfer.Id}", transfer);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("DownloadFile")
.WithDescription("Download a file from a device");

files.MapGet("/transfers", (string? deviceId, FileTransferService fileTransferService) =>
{
    var transfers = fileTransferService.GetTransfers(deviceId);
    return Results.Ok(transfers);
})
.WithName("ListTransfers")
.WithDescription("List all file transfers");

files.MapGet("/transfers/{transferId}", (string transferId, FileTransferService fileTransferService) =>
{
    var transfer = fileTransferService.GetTransfer(transferId);
    return transfer != null ? Results.Ok(transfer) : Results.NotFound();
})
.WithName("GetTransfer")
.WithDescription("Get transfer status");

files.MapDelete("/transfers/{transferId}", (string transferId, FileTransferService fileTransferService) =>
{
    var cancelled = fileTransferService.CancelTransfer(transferId);
    return cancelled ? Results.Ok() : Results.NotFound();
})
.WithName("CancelTransfer")
.WithDescription("Cancel a file transfer");

files.MapPost("/firmware", async (
    FirmwareDeploymentRequest request,
    FileTransferService fileTransferService,
    CancellationToken ct) =>
{
    try
    {
        var deployment = await fileTransferService.DeployFirmwareAsync(request, ct);
        return Results.Accepted($"/api/files/firmware/{deployment.Id}", deployment);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("DeployFirmware")
.WithDescription("Deploy firmware to a device");

files.MapPost("/list", async (
    ListDirectoryRequest request,
    FileTransferService fileTransferService,
    CancellationToken ct) =>
{
    try
    {
        var files = await fileTransferService.ListDirectoryAsync(request, ct);
        return Results.Ok(files);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("ListDirectory")
.WithDescription("List remote directory contents");

// ============================================================================
// REMOTE SESSION ENDPOINTS
// ============================================================================

var sessions = app.MapGroup("/api/sessions").WithTags("Remote Sessions");

sessions.MapPost("/start", async (
    StartSessionRequest request,
    RemoteDesktopService remoteDesktopService,
    CancellationToken ct) =>
{
    try
    {
        var session = await remoteDesktopService.StartSessionAsync(request, ct);
        return Results.Ok(session);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("StartSession")
.WithDescription("Start a remote session");

sessions.MapGet("/", (string? deviceId, RemoteDesktopService remoteDesktopService) =>
{
    var activeSessions = remoteDesktopService.GetActiveSessions(deviceId);
    return Results.Ok(activeSessions);
})
.WithName("ListActiveSessions")
.WithDescription("List active remote sessions");

sessions.MapGet("/{sessionId}", (string sessionId, RemoteDesktopService remoteDesktopService) =>
{
    var session = remoteDesktopService.GetSession(sessionId);
    return session != null ? Results.Ok(session) : Results.NotFound();
})
.WithName("GetSession")
.WithDescription("Get session details");

sessions.MapDelete("/{sessionId}", async (
    string sessionId,
    string? reason,
    RemoteDesktopService remoteDesktopService,
    CancellationToken ct) =>
{
    try
    {
        await remoteDesktopService.EndSessionAsync(sessionId, reason, ct);
        return Results.Ok();
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("EndSession")
.WithDescription("End a remote session");

sessions.MapPost("/{sessionId}/input", async (
    string sessionId,
    InputEventRequest request,
    RemoteDesktopService remoteDesktopService,
    CancellationToken ct) =>
{
    try
    {
        await remoteDesktopService.SendInputEventAsync(request with { SessionId = sessionId }, ct);
        return Results.Ok();
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("SendInput")
.WithDescription("Send input to remote session");

sessions.MapGet("/{sessionId}/stream", (string sessionId, RemoteDesktopService remoteDesktopService) =>
{
    var streamUrl = remoteDesktopService.GetStreamUrl(sessionId);
    return streamUrl != null ? Results.Ok(new { streamUrl }) : Results.NotFound();
})
.WithName("GetStreamUrl")
.WithDescription("Get video stream URL");

sessions.MapGet("/history/{deviceId}", (
    string deviceId,
    int? limit,
    RemoteDesktopService remoteDesktopService) =>
{
    var history = remoteDesktopService.GetSessionHistory(deviceId, limit ?? 50);
    return Results.Ok(history);
})
.WithName("GetSessionHistory")
.WithDescription("Get session history for a device");

// ============================================================================
// PROCESS MONITORING ENDPOINTS
// ============================================================================

var processes = app.MapGroup("/api/processes").WithTags("Process Monitor");

processes.MapGet("/{deviceId}/metrics", async (
    string deviceId,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var metrics = await processMonitorService.GetSystemMetricsAsync(deviceId, ct);
        return Results.Ok(metrics);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("GetSystemMetrics")
.WithDescription("Get system metrics for a device");

processes.MapGet("/{deviceId}", async (
    string deviceId,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var processList = await processMonitorService.GetProcessListAsync(deviceId, ct);
        return Results.Ok(processList);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("GetProcessList")
.WithDescription("Get process list for a device");

processes.MapPost("/start", async (
    ProcessActionRequest request,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var result = await processMonitorService.StartProcessAsync(request, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("StartProcess")
.WithDescription("Start a process on a device");

processes.MapPost("/stop", async (
    ProcessActionRequest request,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var result = await processMonitorService.StopProcessAsync(request, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("StopProcess")
.WithDescription("Stop a process on a device");

processes.MapPost("/restart", async (
    ProcessActionRequest request,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var result = await processMonitorService.RestartProcessAsync(request, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("RestartProcess")
.WithDescription("Restart a process on a device");

processes.MapPost("/{deviceId}/snapshot", async (
    string deviceId,
    ProcessMonitorService processMonitorService,
    CancellationToken ct) =>
{
    try
    {
        var snapshot = await processMonitorService.CaptureSnapshotAsync(deviceId, ct);
        return Results.Ok(snapshot);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
})
.WithName("CaptureSnapshot")
.WithDescription("Capture a process snapshot");

processes.MapGet("/{deviceId}/snapshot/latest", (
    string deviceId,
    ProcessMonitorService processMonitorService) =>
{
    var snapshot = processMonitorService.GetLatestSnapshot(deviceId);
    return snapshot != null ? Results.Ok(snapshot) : Results.NotFound();
})
.WithName("GetLatestSnapshot")
.WithDescription("Get the latest process snapshot");

// ============================================================================
// RUN APPLICATION
// ============================================================================

Log.Information("Starting Ubiquity Bridge API on port {Port}",
    builder.Configuration.GetValue<int>("Port", 8080));

app.Run();
