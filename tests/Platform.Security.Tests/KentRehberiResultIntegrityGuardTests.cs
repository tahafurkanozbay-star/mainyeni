using Api.User.KentRehberi;
using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiResultIntegrityGuardTests
{
    private static KentRehberiResultIntegrityGuard CreateGuard(
        Action<KentRehberiOptions>? configure = null)
    {
        return new KentRehberiResultIntegrityGuard(
            KentRehberiRuntimeTestData.Options(configure));
    }

    [Fact]
    public void ValidCollection_ReturnsIntegrityReport()
    {
        var guard = CreateGuard();

        var report = guard.ValidateCollection(
            KentRehberiRuntimeTestData.Collection(
                count: 3,
                limit: 50));

        Assert.Equal(3, report.FeatureCount);
        Assert.True(report.SerializedBytes > 0);
        Assert.True(report.GeometryNodes > 0);
        Assert.True(report.MaxGeometryDepth > 0);
        Assert.Equal(0, report.DuplicateObjectIds);
    }

    [Fact]
    public void WrongCollectionType_IsRejected()
    {
        var source =
            KentRehberiRuntimeTestData.Collection();

        var invalid = new KentRehberiFeatureCollection(
            "Wrong",
            source.Features,
            source.Meta);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateCollection(
                    invalid));
    }

    [Fact]
    public void MetadataCountMismatch_IsRejected()
    {
        var features =
            new List<KentRehberiFeature>
            {
                KentRehberiRuntimeTestData.Feature()
            };

        var invalid =
            new KentRehberiFeatureCollection(
                "FeatureCollection",
                features,
                new KentRehberiCollectionMeta(
                    2,
                    50,
                    false,
                    null));

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateCollection(
                    invalid));
    }

    [Fact]
    public void ResponseFeatureBudget_IsEnforced()
    {
        var guard = CreateGuard(
            options =>
            {
                options.MaxLimit = 3;
                options.MaxResponseFeatures = 3;
            });

        var invalid =
            KentRehberiRuntimeTestData.Collection(
                count: 4,
                limit: 4);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateCollection(invalid));
    }

    [Fact]
    public void MetadataLimitCannotExceedConfiguredMaximum()
    {
        var guard = CreateGuard(
            options =>
            {
                options.MaxLimit = 10;
                options.MaxResponseFeatures = 10;
            });

        var invalid =
            KentRehberiRuntimeTestData.Collection(
                count: 1,
                limit: 11);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateCollection(invalid));
    }

    [Fact]
    public void CountCannotExceedDeclaredLimit()
    {
        var guard = CreateGuard();

        var features =
            new List<KentRehberiFeature>
            {
                KentRehberiRuntimeTestData.Feature(1),
                KentRehberiRuntimeTestData.Feature(2)
            };

        var invalid =
            new KentRehberiFeatureCollection(
                "FeatureCollection",
                features,
                new KentRehberiCollectionMeta(
                    2,
                    1,
                    true,
                    null));

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateCollection(invalid));
    }

    [Fact]
    public void WrongFeatureType_IsRejected()
    {
        var valid =
            KentRehberiRuntimeTestData.Feature();

        var invalid =
            new KentRehberiFeature(
                "Wrong",
                valid.Id,
                valid.Geometry,
                valid.Properties);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void NonPositiveFeatureId_IsRejected(
        int id)
    {
        var valid =
            KentRehberiRuntimeTestData.Feature();

        var invalid =
            new KentRehberiFeature(
                "Feature",
                id,
                valid.Geometry,
                valid.Properties with
                {
                    ObjectId = id
                });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Fact]
    public void ObjectIdMismatch_IsRejected()
    {
        var valid =
            KentRehberiRuntimeTestData.Feature(10);

        var invalid =
            new KentRehberiFeature(
                "Feature",
                10,
                valid.Geometry,
                valid.Properties with
                {
                    ObjectId = 11
                });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity)]
    public void NonFiniteLongitude_IsRejected(
        double value)
    {
        var invalid =
            KentRehberiRuntimeTestData.Feature(
                x: value);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Theory]
    [InlineData(-180.01)]
    [InlineData(180.01)]
    public void LongitudeOutsideWgs84_IsRejected(
        double value)
    {
        var invalid =
            KentRehberiRuntimeTestData.Feature(
                x: value);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Theory]
    [InlineData(-90.01)]
    [InlineData(90.01)]
    public void LatitudeOutsideWgs84_IsRejected(
        double value)
    {
        var invalid =
            KentRehberiRuntimeTestData.Feature(
                y: value);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Fact]
    public void NegativeDistance_IsRejected()
    {
        var invalid =
            KentRehberiRuntimeTestData.Feature(
                distanceMeters: -1);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Fact]
    public void NullGeometry_IsAccepted()
    {
        var feature =
            KentRehberiRuntimeTestData.Feature(
                geometry: null);

        var noGeometry =
            feature with
            {
                Geometry = null
            };

        var report =
            CreateGuard().ValidateFeature(
                noGeometry);

        Assert.Equal(0, report.GeometryNodes);
        Assert.Equal(0, report.MaxGeometryDepth);
    }

    [Fact]
    public void GeometryMustBeObject()
    {
        var invalid =
            KentRehberiRuntimeTestData.Feature(
                geometry:
                    JsonNode.Parse("[1,2,3]"));

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    invalid));
    }

    [Fact]
    public void GeometryDepthBudget_IsEnforced()
    {
        var geometry = JsonNode.Parse(
            """
            {
              "type": "GeometryCollection",
              "geometries": [
                {
                  "type": "GeometryCollection",
                  "geometries": [
                    {
                      "type": "Point",
                      "coordinates": [32.85, 39.92]
                    }
                  ]
                }
              ]
            }
            """);

        var feature =
            KentRehberiRuntimeTestData.Feature(
                geometry: geometry);
        var guard = CreateGuard(
            options =>
                options.MaxGeometryDepth = 4);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateFeature(feature));
    }

    [Fact]
    public void GeometryNodeBudgetPerFeature_IsEnforced()
    {
        var coordinates =
            new JsonArray();

        for (var index = 0; index < 100; index++)
        {
            coordinates.Add(
                new JsonArray(
                    32.80 + index * 0.001,
                    39.90));
        }

        var geometry =
            new JsonObject
            {
                ["type"] = "LineString",
                ["coordinates"] = coordinates
            };

        var feature =
            KentRehberiRuntimeTestData.Feature(
                geometry: geometry);
        var guard = CreateGuard(
            options =>
                options.MaxGeometryNodesPerFeature = 100);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateFeature(feature));
    }

    [Fact]
    public void GeometryNodeBudgetAcrossResponse_IsEnforced()
    {
        var guard = CreateGuard(
            options =>
            {
                options.MaxGeometryNodesPerFeature = 1000;
                options.MaxGeometryNodesPerResponse = 9;
            });

        var collection =
            KentRehberiRuntimeTestData.Collection(
                count: 2,
                limit: 50);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateCollection(
                    collection));
    }

    [Fact]
    public void NonFiniteGeometryCoordinate_IsRejected()
    {
        var geometry =
            new JsonObject
            {
                ["type"] = "Point",
                ["coordinates"] =
                    new JsonArray(
                        JsonValue.Create(double.NaN),
                        JsonValue.Create(39.92))
            };

        var feature =
            KentRehberiRuntimeTestData.Feature(
                geometry: geometry);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                CreateGuard().ValidateFeature(
                    feature));
    }

    [Fact]
    public void ResponseByteBudget_IsEnforced()
    {
        var guard = CreateGuard(
            options =>
                options.MaxResponseBytes =
                    262_144);

        var hugeName =
            new string('x', 300_000);
        var feature =
            KentRehberiRuntimeTestData.Feature(
                name: hugeName);
        var collection =
            KentRehberiFeatureCollection.Create(
                new[] { feature },
                10,
                false);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () =>
                guard.ValidateCollection(
                    collection));
    }

    [Fact]
    public void DuplicateIds_AreReportedWithoutInventingUniqueness()
    {
        var first =
            KentRehberiRuntimeTestData.Feature(10);
        var second =
            KentRehberiRuntimeTestData.Feature(10);

        var collection =
            KentRehberiFeatureCollection.Create(
                new[]
                {
                    first,
                    second
                },
                10,
                false);

        var report =
            CreateGuard().ValidateCollection(
                collection);

        Assert.Equal(
            1,
            report.DuplicateObjectIds);
    }

    [Fact]
    public void ValidNearbyDistance_IsAccepted()
    {
        var feature =
            KentRehberiRuntimeTestData.Feature(
                distanceMeters: 123.45);

        var report =
            CreateGuard().ValidateFeature(
                feature);

        Assert.Equal(1, report.FeatureCount);
        Assert.True(report.SerializedBytes > 0);
    }
}
