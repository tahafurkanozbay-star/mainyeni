using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Api.User.KentRehberi;

public sealed record KentRehberiTypeCatalogIntegrityReport(
    int TypeCount,
    int SampleCount,
    long SerializedBytes);

public sealed class KentRehberiTypeCatalogIntegrityGuard
{
    private readonly KentRehberiOptions options;

    public KentRehberiTypeCatalogIntegrityGuard(
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        this.options = options;
    }

    public KentRehberiTypeCatalogIntegrityReport Validate(
        KentRehberiTypeCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(catalog);
        ArgumentNullException.ThrowIfNull(catalog.Types);

        if (catalog.Types.Count > options.TypeCatalogMaxTypes)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi type catalog exceeded the configured type budget.");
        }

        var seenTypes = new HashSet<short>();
        var sampleCount = 0;

        foreach (var descriptor in catalog.Types)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            ArgumentNullException.ThrowIfNull(descriptor.Samples);

            if (!seenTypes.Add(descriptor.Tur))
            {
                throw new KentRehberiDataIntegrityException(
                    "Kent Rehberi type catalog contains duplicate type identifiers.");
            }

            if (descriptor.Count < 0)
            {
                throw new KentRehberiDataIntegrityException(
                    "Kent Rehberi type catalog contains a negative aggregate count.");
            }

            if (descriptor.Samples.Count > options.TypeCatalogSamplesPerType)
            {
                throw new KentRehberiDataIntegrityException(
                    "Kent Rehberi type catalog exceeded the configured sample budget.");
            }

            if (descriptor.Count < descriptor.Samples.Count)
            {
                throw new KentRehberiDataIntegrityException(
                    "Kent Rehberi type catalog sample count exceeds its aggregate count.");
            }

            var seenObjectIds = new HashSet<int>();

            foreach (var sample in descriptor.Samples)
            {
                ArgumentNullException.ThrowIfNull(sample);

                if (sample.ObjectId <= 0)
                {
                    throw new KentRehberiDataIntegrityException(
                        "Kent Rehberi type catalog contains an invalid object identifier.");
                }

                if (!seenObjectIds.Add(sample.ObjectId))
                {
                    throw new KentRehberiDataIntegrityException(
                        "Kent Rehberi type catalog contains duplicate sample identifiers.");
                }

                ValidateText(sample.Adi);
                ValidateText(sample.Adres);
                ValidateText(sample.DurakNo);
                sampleCount++;
            }
        }

        var serializedBytes =
            JsonSerializer.SerializeToUtf8Bytes(catalog).LongLength;

        if (serializedBytes > options.TypeCatalogMaxResponseBytes)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi type catalog exceeded the configured response byte budget.");
        }

        return new KentRehberiTypeCatalogIntegrityReport(
            catalog.Types.Count,
            sampleCount,
            serializedBytes);
    }

    private void ValidateText(string? value)
    {
        if (value is null)
        {
            return;
        }

        if (value.Length > options.TypeCatalogMaxTextLength)
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi type catalog contains text beyond the configured limit.");
        }

        if (value.Any(char.IsControl))
        {
            throw new KentRehberiDataIntegrityException(
                "Kent Rehberi type catalog contains control characters.");
        }
    }
}
