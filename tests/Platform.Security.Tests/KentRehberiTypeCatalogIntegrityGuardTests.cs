using Api.User.KentRehberi;
using System;
using System.Collections.Generic;
using Xunit;

namespace Platform.Security.Tests;

public sealed class KentRehberiTypeCatalogIntegrityGuardTests
{
    [Fact]
    public void ValidCatalog_ReturnsBoundedReport()
    {
        var options = KentRehberiRuntimeTestData.Options();
        var guard = new KentRehberiTypeCatalogIntegrityGuard(options);
        var catalog = KentRehberiRuntimeTestData.TypeCatalog(
            typeCount: 3,
            samplesPerType: 2);

        var report = guard.Validate(catalog);

        Assert.Equal(3, report.TypeCount);
        Assert.Equal(6, report.SampleCount);
        Assert.InRange(
            report.SerializedBytes,
            1,
            options.TypeCatalogMaxResponseBytes);
    }

    [Fact]
    public void DuplicateType_IsRejected()
    {
        var guard = CreateGuard();
        var sample = Sample(1);
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(7, 10, sample),
                Descriptor(7, 12, Sample(2))
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void NegativeAggregateCount_IsRejected()
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                new KentRehberiTypeDescriptor(
                    7,
                    -1,
                    Array.Empty<KentRehberiTypeSample>())
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void SampleCountCannotExceedAggregateCount()
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                new KentRehberiTypeDescriptor(
                    7,
                    1,
                    new[]
                    {
                        Sample(1),
                        Sample(2)
                    })
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void SampleBudget_IsEnforced()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.TypeCatalogSamplesPerType = 2);
        var guard =
            new KentRehberiTypeCatalogIntegrityGuard(
                options);

        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                new KentRehberiTypeDescriptor(
                    7,
                    10,
                    new[]
                    {
                        Sample(1),
                        Sample(2),
                        Sample(3)
                    })
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void TypeBudget_IsEnforced()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.TypeCatalogMaxTypes = 2);
        var guard =
            new KentRehberiTypeCatalogIntegrityGuard(
                options);

        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(1, 1, Sample(1)),
                Descriptor(2, 1, Sample(2)),
                Descriptor(3, 1, Sample(3))
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void InvalidObjectId_IsRejected()
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(
                    7,
                    1,
                    new KentRehberiTypeSample(
                        0,
                        "Park",
                        "Ankara",
                        null))
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void DuplicateSampleObjectIdWithinType_IsRejected()
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                new KentRehberiTypeDescriptor(
                    7,
                    10,
                    new[]
                    {
                        Sample(1),
                        Sample(1)
                    })
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void SameObjectIdAcrossDifferentTypes_IsAllowed()
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(7, 1, Sample(1)),
                Descriptor(8, 1, Sample(1))
            });

        var report = guard.Validate(catalog);

        Assert.Equal(2, report.SampleCount);
    }

    [Theory]
    [InlineData("adi")]
    [InlineData("adres")]
    [InlineData("durak")]
    public void TextBudget_IsEnforced(
        string target)
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                    value.TypeCatalogMaxTextLength = 32);
        var guard =
            new KentRehberiTypeCatalogIntegrityGuard(
                options);
        var longText = new string('x', 33);

        var sample = target switch
        {
            "adi" =>
                new KentRehberiTypeSample(
                    1,
                    longText,
                    "Ankara",
                    null),
            "adres" =>
                new KentRehberiTypeSample(
                    1,
                    "Park",
                    longText,
                    null),
            _ =>
                new KentRehberiTypeSample(
                    1,
                    "Park",
                    "Ankara",
                    longText)
        };

        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(7, 1, sample)
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Theory]
    [InlineData("Park\nMerkez")]
    [InlineData("Park\rMerkez")]
    [InlineData("Park\tMerkez")]
    public void ControlCharacters_AreRejected(
        string unsafeText)
    {
        var guard = CreateGuard();
        var catalog = KentRehberiTypeCatalog.Create(
            new[]
            {
                Descriptor(
                    7,
                    1,
                    new KentRehberiTypeSample(
                        1,
                        unsafeText,
                        "Ankara",
                        null))
            });

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void ResponseByteBudget_IsEnforced()
    {
        var options =
            KentRehberiRuntimeTestData.Options(
                value =>
                {
                    value.TypeCatalogMaxTypes = 64;
                    value.TypeCatalogSamplesPerType = 32;
                    value.TypeCatalogMaxTextLength = 1024;
                    value.TypeCatalogMaxResponseBytes = 32768;
                });
        var guard =
            new KentRehberiTypeCatalogIntegrityGuard(
                options);

        var types =
            new List<KentRehberiTypeDescriptor>();
        var id = 1;

        for (short type = 1; type <= 32; type++)
        {
            var samples =
                new List<KentRehberiTypeSample>();

            for (var index = 0; index < 32; index++)
            {
                samples.Add(
                    new KentRehberiTypeSample(
                        id++,
                        new string('a', 300),
                        new string('b', 300),
                        new string('c', 100)));
            }

            types.Add(
                new KentRehberiTypeDescriptor(
                    type,
                    1000,
                    samples));
        }

        var catalog =
            KentRehberiTypeCatalog.Create(types);

        Assert.Throws<KentRehberiDataIntegrityException>(
            () => guard.Validate(catalog));
    }

    [Fact]
    public void EmptyCatalog_IsValid()
    {
        var guard = CreateGuard();

        var report = guard.Validate(
            KentRehberiTypeCatalog.Create(
                Array.Empty<KentRehberiTypeDescriptor>()));

        Assert.Equal(0, report.TypeCount);
        Assert.Equal(0, report.SampleCount);
        Assert.True(report.SerializedBytes > 0);
    }

    private static KentRehberiTypeCatalogIntegrityGuard
        CreateGuard() =>
        new(
            KentRehberiRuntimeTestData.Options());

    private static KentRehberiTypeSample Sample(
        int objectId) =>
        new(
            objectId,
            "Örnek Park",
            "Ankara",
            objectId.ToString());

    private static KentRehberiTypeDescriptor Descriptor(
        short type,
        long count,
        params KentRehberiTypeSample[] samples) =>
        new(
            type,
            count,
            samples);
}
