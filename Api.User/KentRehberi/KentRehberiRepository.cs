using Npgsql;
using System;
using System.Collections.Generic;
using System.Data;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public interface IKentRehberiRepository
{
    bool IsConfigured { get; }

    Task<KentRehberiFeatureCollection> SearchAsync(
        KentRehberiSearchCriteria criteria,
        CancellationToken cancellationToken);

    Task<KentRehberiFeature?> GetByObjectIdAsync(
        int objectId,
        CancellationToken cancellationToken);

    Task<KentRehberiFeatureCollection> FindNearbyAsync(
        KentRehberiNearbyCriteria criteria,
        CancellationToken cancellationToken);

    Task<KentRehberiTypeCatalog> GetTypeCatalogAsync(
        CancellationToken cancellationToken);
}

public sealed class KentRehberiRepository : IKentRehberiRepository
{
    private const string QualifiedTableName =
        "kent_rehberi.kent_rehberi_tumu_pggeom";

    private const string SelectColumns = """
        t.objectid,
        t.adi,
        t.adres,
        t.ilce,
        t.mahalle,
        t.x::double precision AS x,
        t.y::double precision AS y,
        t.tur,
        t.yapan,
        t.web_sayfasi,
        t.durak_no,
        CASE
            WHEN t.shape IS NULL THEN NULL
            ELSE ST_AsGeoJSON(t.shape, 8)
        END AS geometry_json
        """;

    private readonly KentRehberiConnectionFactory connectionFactory;
    private readonly KentRehberiOptions options;

    public KentRehberiRepository(
        KentRehberiConnectionFactory connectionFactory,
        KentRehberiOptions options)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory);
        ArgumentNullException.ThrowIfNull(options);

        this.connectionFactory = connectionFactory;
        this.options = options;
    }

    public bool IsConfigured => connectionFactory.IsConfigured;

    public async Task<KentRehberiFeatureCollection> SearchAsync(
        KentRehberiSearchCriteria criteria,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        await using var connection = connectionFactory.CreateConnection();
        await connection.OpenAsync(cancellationToken);

        var sql = new StringBuilder();
        sql.Append("SELECT ");
        sql.Append(SelectColumns);
        sql.Append(" FROM ");
        sql.Append(QualifiedTableName);
        sql.Append(" AS t WHERE TRUE");

        await using var command = CreateCommand(connection);
        AppendCommonFilters(
            sql,
            command,
            criteria.Ilce,
            criteria.Mahalle,
            criteria.Tur,
            criteria.Query);

        if (criteria.Bounds is not null)
        {
            sql.Append("""
                 AND t.shape IS NOT NULL
                 AND t.shape && ST_MakeEnvelope(
                     @minLongitude,
                     @minLatitude,
                     @maxLongitude,
                     @maxLatitude,
                     4326)
                 AND ST_Intersects(
                     t.shape,
                     ST_MakeEnvelope(
                         @minLongitude,
                         @minLatitude,
                         @maxLongitude,
                         @maxLatitude,
                         4326))
                """);

            command.Parameters.AddWithValue(
                "minLongitude",
                criteria.Bounds.MinLongitude);
            command.Parameters.AddWithValue(
                "minLatitude",
                criteria.Bounds.MinLatitude);
            command.Parameters.AddWithValue(
                "maxLongitude",
                criteria.Bounds.MaxLongitude);
            command.Parameters.AddWithValue(
                "maxLatitude",
                criteria.Bounds.MaxLatitude);
        }

        if (criteria.AfterObjectId.HasValue)
        {
            sql.Append(" AND t.objectid > @afterObjectId");
            command.Parameters.AddWithValue(
                "afterObjectId",
                criteria.AfterObjectId.Value);
        }

        sql.Append(" ORDER BY t.objectid ASC LIMIT @fetchLimit");
        command.Parameters.AddWithValue("fetchLimit", criteria.Limit + 1);
        command.CommandText = sql.ToString();

        var features = await ReadFeaturesAsync(
            command,
            criteria.Limit + 1,
            includesDistance: false,
            cancellationToken);

        var hasMore = features.Count > criteria.Limit;
        if (hasMore)
        {
            features.RemoveAt(features.Count - 1);
        }

        var nextAfterObjectId =
            hasMore && options.ObjectIdCursorEnabled && features.Count > 0
                ? features[^1].Id
                : (int?)null;

        return KentRehberiFeatureCollection.Create(
            features,
            criteria.Limit,
            hasMore,
            nextAfterObjectId);
    }

    public async Task<KentRehberiFeature?> GetByObjectIdAsync(
        int objectId,
        CancellationToken cancellationToken)
    {
        if (objectId <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(objectId),
                "objectId must be greater than zero.");
        }

        await using var connection = connectionFactory.CreateConnection();
        await connection.OpenAsync(cancellationToken);

        var sql = $"SELECT {SelectColumns} " +
                  $"FROM {QualifiedTableName} AS t " +
                  "WHERE t.objectid = @objectId " +
                  "ORDER BY t.objectid ASC LIMIT 1";

        await using var command = CreateCommand(connection);
        command.CommandText = sql;
        command.Parameters.AddWithValue("objectId", objectId);

        var features = await ReadFeaturesAsync(
            command,
            capacity: 1,
            includesDistance: false,
            cancellationToken);

        return features.Count == 0 ? null : features[0];
    }

    public async Task<KentRehberiFeatureCollection> FindNearbyAsync(
        KentRehberiNearbyCriteria criteria,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        await using var connection = connectionFactory.CreateConnection();
        await connection.OpenAsync(cancellationToken);

        var sql = new StringBuilder();
        sql.Append("SELECT ");
        sql.Append(SelectColumns);
        sql.Append(
            ", ST_Distance(t.shape::geography, anchor.geom::geography) " +
            "AS distance_meters ");
        sql.Append("FROM ");
        sql.Append(QualifiedTableName);
        sql.Append("""
             AS t
             CROSS JOIN (
                 SELECT ST_SetSRID(
                     ST_MakePoint(@longitude, @latitude),
                     4326) AS geom
             ) AS anchor
             WHERE t.shape IS NOT NULL
               AND ST_DWithin(
                   t.shape::geography,
                   anchor.geom::geography,
                   @radiusMeters)
            """);

        await using var command = CreateCommand(connection);
        command.Parameters.AddWithValue("longitude", criteria.Longitude);
        command.Parameters.AddWithValue("latitude", criteria.Latitude);
        command.Parameters.AddWithValue("radiusMeters", criteria.RadiusMeters);

        AppendCommonFilters(
            sql,
            command,
            criteria.Ilce,
            criteria.Mahalle,
            criteria.Tur,
            criteria.Query);

        sql.Append(
            " ORDER BY distance_meters ASC, t.objectid ASC " +
            "LIMIT @fetchLimit");
        command.Parameters.AddWithValue("fetchLimit", criteria.Limit + 1);
        command.CommandText = sql.ToString();

        var features = await ReadFeaturesAsync(
            command,
            criteria.Limit + 1,
            includesDistance: true,
            cancellationToken);

        var hasMore = features.Count > criteria.Limit;
        if (hasMore)
        {
            features.RemoveAt(features.Count - 1);
        }

        return KentRehberiFeatureCollection.Create(
            features,
            criteria.Limit,
            hasMore);
    }

    public async Task<KentRehberiTypeCatalog> GetTypeCatalogAsync(
        CancellationToken cancellationToken)
    {
        await using var connection = connectionFactory.CreateConnection();
        await connection.OpenAsync(cancellationToken);

        const string sql = """
            SELECT
                type_counts.tur,
                type_counts.item_count,
                samples.objectid,
                samples.adi,
                samples.adres,
                samples.durak_no
            FROM (
                SELECT
                    t.tur,
                    COUNT(*)::bigint AS item_count
                FROM kent_rehberi.kent_rehberi_tumu_pggeom AS t
                WHERE t.tur IS NOT NULL
                GROUP BY t.tur
                ORDER BY t.tur ASC
                LIMIT @maxTypes
            ) AS type_counts
            LEFT JOIN LATERAL (
                SELECT
                    s.objectid,
                    s.adi,
                    s.adres,
                    s.durak_no
                FROM kent_rehberi.kent_rehberi_tumu_pggeom AS s
                WHERE s.tur = type_counts.tur
                ORDER BY s.objectid ASC
                LIMIT @samplesPerType
            ) AS samples ON TRUE
            ORDER BY type_counts.tur ASC, samples.objectid ASC
            """;

        await using var command = CreateCommand(connection);
        command.CommandText = sql;
        command.Parameters.AddWithValue(
            "maxTypes",
            options.TypeCatalogMaxTypes);
        command.Parameters.AddWithValue(
            "samplesPerType",
            options.TypeCatalogSamplesPerType);

        var descriptors =
            new List<KentRehberiTypeDescriptor>();
        short? currentType = null;
        long currentCount = 0;
        List<KentRehberiTypeSample>? samples = null;

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SequentialAccess,
            cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var type = reader.GetInt16(0);
            var count = reader.GetInt64(1);

            if (currentType != type)
            {
                if (currentType.HasValue && samples is not null)
                {
                    descriptors.Add(
                        new KentRehberiTypeDescriptor(
                            currentType.Value,
                            currentCount,
                            samples));
                }

                currentType = type;
                currentCount = count;
                samples =
                    new List<KentRehberiTypeSample>(
                        options.TypeCatalogSamplesPerType);
            }

            if (reader.IsDBNull(2))
            {
                continue;
            }

            samples!.Add(
                new KentRehberiTypeSample(
                    reader.GetInt32(2),
                    ReadNullableString(reader, 3),
                    ReadNullableString(reader, 4),
                    ReadNullableString(reader, 5)));
        }

        if (currentType.HasValue && samples is not null)
        {
            descriptors.Add(
                new KentRehberiTypeDescriptor(
                    currentType.Value,
                    currentCount,
                    samples));
        }

        return KentRehberiTypeCatalog.Create(descriptors);
    }

    private NpgsqlCommand CreateCommand(NpgsqlConnection connection)
    {
        return new NpgsqlCommand
        {
            Connection = connection,
            CommandTimeout = options.CommandTimeoutSeconds
        };
    }

    private static void AppendCommonFilters(
        StringBuilder sql,
        NpgsqlCommand command,
        string? ilce,
        string? mahalle,
        short? tur,
        string? query)
    {
        if (ilce is not null)
        {
            sql.Append(" AND lower(t.ilce) = lower(@ilce)");
            command.Parameters.AddWithValue("ilce", ilce);
        }

        if (mahalle is not null)
        {
            sql.Append(" AND lower(t.mahalle) = lower(@mahalle)");
            command.Parameters.AddWithValue("mahalle", mahalle);
        }

        if (tur.HasValue)
        {
            sql.Append(" AND t.tur = @tur");
            command.Parameters.AddWithValue("tur", tur.Value);
        }

        if (query is not null)
        {
            sql.Append("""
                 AND (
                     t.adi ILIKE @query ESCAPE '\'
                     OR t.adres ILIKE @query ESCAPE '\'
                     OR t.ilce ILIKE @query ESCAPE '\'
                     OR t.mahalle ILIKE @query ESCAPE '\'
                     OR t.durak_no ILIKE @query ESCAPE '\'
                 )
                """);

            command.Parameters.AddWithValue(
                "query",
                $"%{KentRehberiQueryValidation.EscapeLikePattern(query)}%");
        }
    }

    private static async Task<List<KentRehberiFeature>> ReadFeaturesAsync(
        NpgsqlCommand command,
        int capacity,
        bool includesDistance,
        CancellationToken cancellationToken)
    {
        var features = new List<KentRehberiFeature>(
            Math.Max(0, capacity));

        await using var reader = await command.ExecuteReaderAsync(
            CommandBehavior.SequentialAccess,
            cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var objectId = reader.GetInt32(0);
            var geometry = ReadGeometry(reader, 11);
            var distance = includesDistance && !reader.IsDBNull(12)
                ? Math.Round(reader.GetDouble(12), 2, MidpointRounding.AwayFromZero)
                : (double?)null;

            var properties = new KentRehberiFeatureProperties(
                objectId,
                ReadNullableString(reader, 1),
                ReadNullableString(reader, 2),
                ReadNullableString(reader, 3),
                ReadNullableString(reader, 4),
                ReadNullableDouble(reader, 5),
                ReadNullableDouble(reader, 6),
                ReadNullableInt16(reader, 7),
                ReadNullableInt16(reader, 8),
                ReadNullableString(reader, 9),
                ReadNullableString(reader, 10),
                distance);

            features.Add(
                KentRehberiFeature.Create(
                    objectId,
                    geometry,
                    properties));
        }

        return features;
    }

    private static JsonNode? ReadGeometry(
        NpgsqlDataReader reader,
        int ordinal)
    {
        if (reader.IsDBNull(ordinal))
        {
            return null;
        }

        return JsonNode.Parse(reader.GetString(ordinal));
    }

    private static string? ReadNullableString(
        NpgsqlDataReader reader,
        int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);

    private static double? ReadNullableDouble(
        NpgsqlDataReader reader,
        int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetDouble(ordinal);

    private static short? ReadNullableInt16(
        NpgsqlDataReader reader,
        int ordinal) =>
        reader.IsDBNull(ordinal) ? null : reader.GetInt16(ordinal);
}
