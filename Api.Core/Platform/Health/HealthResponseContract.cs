#nullable enable

using System.Text.Json.Serialization;

namespace Api.Core.Platform.Health;

internal sealed record HealthResponsePayload(
    string Status,
    long TotalDurationMs,
    HealthCheckResponsePayload[] Checks);

internal sealed record HealthCheckResponsePayload(
    string Name,
    string Status,
    long DurationMs);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    GenerationMode = JsonSourceGenerationMode.Serialization)]
[JsonSerializable(typeof(HealthResponsePayload))]
internal sealed partial class HealthJsonSerializerContext : JsonSerializerContext
{
}
