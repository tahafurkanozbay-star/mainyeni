using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Api.User.KentRehberi;

public sealed record KentRehberiIntegrityReport(
    int FeatureCount,
    long SerializedBytes,
    int GeometryNodes,
    int MaxGeometryDepth,
    int DuplicateObjectIds);

public sealed class KentRehberiDataIntegrityException : InvalidOperationException
{
    public KentRehberiDataIntegrityException(string message)
        : base(message)
    {
    }
}

public sealed class KentRehberiResultIntegrityGuard
{
    private readonly KentRehberiOptions options;

    public KentRehberiResultIntegrityGuard(
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        this.options = options;
    }

    public KentRehberiIntegrityReport ValidateCollection(
        KentRehberiFeatureCollection collection)
    {
        ArgumentNullException.ThrowIfNull(collection);

        if (!string.Equals(
                collection.Type,
                "FeatureCollection",
                StringComparison.Ordinal))
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi collection type is invalid.");
        }

        if (collection.Features is null)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature collection is missing features.");
        }

        if (collection.Meta is null)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature collection is missing metadata.");
        }

        if (collection.Features.Count !=
            collection.Meta.Count)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature count does not match metadata.");
        }

        if (collection.Meta.Count >
            options.MaxResponseFeatures)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi response exceeds the configured feature budget.");
        }

        if (collection.Meta.Limit < 1 ||
            collection.Meta.Limit > options.MaxLimit)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi response metadata contains an invalid limit.");
        }

        if (collection.Meta.Count >
            collection.Meta.Limit)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi response exceeds its declared result limit.");
        }

        var ids = new HashSet<int>();
        var duplicateIds = 0;
        var geometryNodes = 0;
        var maxGeometryDepth = 0;

        foreach (var feature in collection.Features)
        {
            var featureReport = ValidateFeatureInternal(
                feature);

            if (!ids.Add(feature.Id))
            {
                duplicateIds++;
            }

            geometryNodes = checked(
                geometryNodes +
                featureReport.GeometryNodes);
            maxGeometryDepth = Math.Max(
                maxGeometryDepth,
                featureReport.MaxGeometryDepth);

            if (geometryNodes >
                options.MaxGeometryNodesPerResponse)
            {
                throw new KentRehberiDataIntegrityException(
                    "Kent Rehberi response exceeds the configured geometry-node budget.");
            }
        }

        var serializedBytes =
            JsonSerializer.SerializeToUtf8Bytes(
                collection).LongLength;

        if (serializedBytes >
            options.MaxResponseBytes)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi response exceeds the configured byte budget.");
        }

        return new KentRehberiIntegrityReport(
            collection.Features.Count,
            serializedBytes,
            geometryNodes,
            maxGeometryDepth,
            duplicateIds);
    }

    public KentRehberiIntegrityReport ValidateFeature(
        KentRehberiFeature feature)
    {
        ArgumentNullException.ThrowIfNull(feature);

        var featureReport = ValidateFeatureInternal(feature);
        var serializedBytes =
            JsonSerializer.SerializeToUtf8Bytes(
                feature).LongLength;

        if (serializedBytes >
            options.MaxResponseBytes)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature exceeds the configured byte budget.");
        }

        return new KentRehberiIntegrityReport(
            1,
            serializedBytes,
            featureReport.GeometryNodes,
            featureReport.MaxGeometryDepth,
            0);
    }

    private GeometryReport ValidateFeatureInternal(
        KentRehberiFeature feature)
    {
        if (!string.Equals(
                feature.Type,
                "Feature",
                StringComparison.Ordinal))
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature type is invalid.");
        }

        if (feature.Id <= 0)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature id must be positive.");
        }

        if (feature.Properties is null)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature properties are missing.");
        }

        if (feature.Properties.ObjectId != feature.Id)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature id does not match objectid.");
        }

        EnsureFinite(
            feature.Properties.X,
            "x");
        EnsureFinite(
            feature.Properties.Y,
            "y");
        EnsureFinite(
            feature.Properties.DistanceMeters,
            "distanceMeters");

        if (feature.Properties.X is < -180d or > 180d)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature x is outside EPSG:4326 longitude bounds.");
        }

        if (feature.Properties.Y is < -90d or > 90d)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature y is outside EPSG:4326 latitude bounds.");
        }

        if (feature.Properties.DistanceMeters < 0d)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi feature distance cannot be negative.");
        }

        if (feature.Geometry is null)
        {
            return new GeometryReport(0, 0);
        }

        if (feature.Geometry.GetValueKind() !=
            JsonValueKind.Object)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi geometry must be a GeoJSON object.");
        }

        var report = InspectGeometry(
            feature.Geometry,
            depth: 1);

        if (report.MaxGeometryDepth >
            options.MaxGeometryDepth)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi geometry exceeds the configured nesting depth.");
        }

        if (report.GeometryNodes >
            options.MaxGeometryNodesPerFeature)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi geometry exceeds the configured node budget.");
        }

        return report;
    }

    private static GeometryReport InspectGeometry(
        JsonNode node,
        int depth)
    {
        var nodes = 1;
        var maxDepth = depth;

        if (node is JsonObject jsonObject)
        {
            foreach (var property in jsonObject)
            {
                if (property.Value is null)
                {
                    continue;
                }

                var child = InspectGeometry(
                    property.Value,
                    depth + 1);
                nodes = checked(
                    nodes +
                    child.GeometryNodes);
                maxDepth = Math.Max(
                    maxDepth,
                    child.MaxGeometryDepth);
            }
        }
        else if (node is JsonArray jsonArray)
        {
            foreach (var item in jsonArray)
            {
                if (item is null)
                {
                    continue;
                }

                var child = InspectGeometry(
                    item,
                    depth + 1);
                nodes = checked(
                    nodes +
                    child.GeometryNodes);
                maxDepth = Math.Max(
                    maxDepth,
                    child.MaxGeometryDepth);
            }
        }

        return new GeometryReport(
            nodes,
            maxDepth);
    }

    private static void EnsureFinite(
        double? value,
        string name)
    {
        if (value.HasValue &&
            !double.IsFinite(value.Value))
        {
            throw new KentRehberiDataIntegrityException(
                $"Kent Rehberi feature {name} must be finite.");
        }
    }

    private sealed record GeometryReport(
        int GeometryNodes,
        int MaxGeometryDepth);
}
