using System.Collections.Generic;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Api.User.KentRehberi;

public sealed record KentRehberiFeature(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("geometry")] JsonNode? Geometry,
    [property: JsonPropertyName("properties")] KentRehberiFeatureProperties Properties)
{
    public static KentRehberiFeature Create(
        int objectId,
        JsonNode? geometry,
        KentRehberiFeatureProperties properties) =>
        new("Feature", objectId, geometry, properties);
}

public sealed record KentRehberiFeatureProperties(
    [property: JsonPropertyName("objectid")] int ObjectId,
    [property: JsonPropertyName("adi")] string? Adi,
    [property: JsonPropertyName("adres")] string? Adres,
    [property: JsonPropertyName("ilce")] string? Ilce,
    [property: JsonPropertyName("mahalle")] string? Mahalle,
    [property: JsonPropertyName("x")] double? X,
    [property: JsonPropertyName("y")] double? Y,
    [property: JsonPropertyName("tur")] short? Tur,
    [property: JsonPropertyName("yapan")] short? Yapan,
    [property: JsonPropertyName("webSayfasi")] string? WebSayfasi,
    [property: JsonPropertyName("durakNo")] string? DurakNo,
    [property: JsonPropertyName("distanceMeters")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    double? DistanceMeters);

public sealed record KentRehberiCollectionMeta(
    [property: JsonPropertyName("count")] int Count,
    [property: JsonPropertyName("limit")] int Limit,
    [property: JsonPropertyName("hasMore")] bool HasMore,
    [property: JsonPropertyName("nextAfterObjectId")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    int? NextAfterObjectId);

public sealed record KentRehberiFeatureCollection(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("features")] IReadOnlyList<KentRehberiFeature> Features,
    [property: JsonPropertyName("meta")] KentRehberiCollectionMeta Meta)
{
    public static KentRehberiFeatureCollection Create(
        IReadOnlyList<KentRehberiFeature> features,
        int limit,
        bool hasMore,
        int? nextAfterObjectId = null) =>
        new(
            "FeatureCollection",
            features,
            new KentRehberiCollectionMeta(
                features.Count,
                limit,
                hasMore,
                nextAfterObjectId));
}

public sealed record KentRehberiCapabilities(
    [property: JsonPropertyName("service")] string Service,
    [property: JsonPropertyName("geometrySrid")] int GeometrySrid,
    [property: JsonPropertyName("defaultLimit")] int DefaultLimit,
    [property: JsonPropertyName("maxLimit")] int MaxLimit,
    [property: JsonPropertyName("maxRadiusMeters")] int MaxRadiusMeters,
    [property: JsonPropertyName("objectIdCursorEnabled")] bool ObjectIdCursorEnabled,
    [property: JsonPropertyName("filters")] IReadOnlyList<string> Filters);
