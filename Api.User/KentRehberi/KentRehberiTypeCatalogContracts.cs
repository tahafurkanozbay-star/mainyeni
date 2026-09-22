using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Api.User.KentRehberi;

/// <summary>
/// Small, bounded sample used by the frontend to resolve stable Kent Rehberi
/// type ids without exposing database topology or downloading an entire type.
/// </summary>
public sealed record KentRehberiTypeSample(
    [property: JsonPropertyName("objectid")] int ObjectId,
    [property: JsonPropertyName("adi")] string? Adi,
    [property: JsonPropertyName("adres")] string? Adres,
    [property: JsonPropertyName("durakNo")] string? DurakNo);

/// <summary>
/// Public description of one numeric <c>tur</c> value.  The count is an
/// aggregate only; samples are deliberately bounded and contain the same
/// already-public fields used by the GeoJSON endpoint.
/// </summary>
public sealed record KentRehberiTypeDescriptor(
    [property: JsonPropertyName("tur")] short Tur,
    [property: JsonPropertyName("count")] long Count,
    [property: JsonPropertyName("samples")]
    IReadOnlyList<KentRehberiTypeSample> Samples);

/// <summary>
/// Bounded type catalog used by the browser to map the historical fast-access
/// menu to PostGIS <c>tur</c> values at runtime.  It intentionally carries no
/// connection, schema, SQL, host, account or exception details.
/// </summary>
public sealed record KentRehberiTypeCatalog(
    [property: JsonPropertyName("types")]
    IReadOnlyList<KentRehberiTypeDescriptor> Types)
{
    public static KentRehberiTypeCatalog Create(
        IReadOnlyList<KentRehberiTypeDescriptor> types) =>
        new(types);
}
