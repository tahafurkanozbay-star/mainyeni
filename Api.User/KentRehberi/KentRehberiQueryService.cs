using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public interface IKentRehberiQueryService
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
}

public sealed class KentRehberiQueryDeadlineException : TimeoutException
{
    public KentRehberiQueryDeadlineException(string message)
        : base(message)
    {
    }
}

public sealed class KentRehberiQueryService :
    IKentRehberiQueryService
{
    private readonly IKentRehberiRepository repository;
    private readonly KentRehberiOptions options;
    private readonly KentRehberiBoundedResultCache cache;
    private readonly KentRehberiAdmissionController admission;
    private readonly KentRehberiSingleFlight<KentRehberiFeatureCollection>
        collectionSingleFlight;
    private readonly KentRehberiSingleFlight<KentRehberiFeature?>
        featureSingleFlight;
    private readonly KentRehberiResultIntegrityGuard integrity;
    private readonly KentRehberiTelemetry telemetry;

    public KentRehberiQueryService(
        IKentRehberiRepository repository,
        KentRehberiOptions options,
        KentRehberiBoundedResultCache cache,
        KentRehberiAdmissionController admission,
        KentRehberiSingleFlight<KentRehberiFeatureCollection>
            collectionSingleFlight,
        KentRehberiSingleFlight<KentRehberiFeature?>
            featureSingleFlight,
        KentRehberiResultIntegrityGuard integrity,
        KentRehberiTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(repository);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(cache);
        ArgumentNullException.ThrowIfNull(admission);
        ArgumentNullException.ThrowIfNull(collectionSingleFlight);
        ArgumentNullException.ThrowIfNull(featureSingleFlight);
        ArgumentNullException.ThrowIfNull(integrity);
        ArgumentNullException.ThrowIfNull(telemetry);

        this.repository = repository;
        this.options = options;
        this.cache = cache;
        this.admission = admission;
        this.collectionSingleFlight = collectionSingleFlight;
        this.featureSingleFlight = featureSingleFlight;
        this.integrity = integrity;
        this.telemetry = telemetry;
    }

    public bool IsConfigured =>
        repository.IsConfigured;

    public async Task<KentRehberiFeatureCollection> SearchAsync(
        KentRehberiSearchCriteria criteria,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var plan = KentRehberiQueryPlan.Search(
            criteria,
            options);

        if (TryReadCache(
                plan,
                out var cached))
        {
            return cached;
        }

        try
        {
            return await collectionSingleFlight.RunAsync(
                plan.Operation,
                plan.Fingerprint,
                plan.Deadline,
                token => ExecuteCollectionAsync(
                    plan,
                    token,
                    ct => repository.SearchAsync(
                        criteria,
                        ct)),
                cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            telemetry.DeadlineExceeded(plan.Operation);
            throw new KentRehberiQueryDeadlineException(
                "Kent Rehberi search exceeded its execution deadline.");
        }
    }

    public async Task<KentRehberiFeature?> GetByObjectIdAsync(
        int objectId,
        CancellationToken cancellationToken)
    {
        var plan = KentRehberiQueryPlan.ObjectById(
            objectId,
            options);

        try
        {
            return await featureSingleFlight.RunAsync(
                plan.Operation,
                plan.Fingerprint,
                plan.Deadline,
                token => ExecuteFeatureAsync(
                    plan,
                    token,
                    ct => repository.GetByObjectIdAsync(
                        objectId,
                        ct)),
                cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            telemetry.DeadlineExceeded(plan.Operation);
            throw new KentRehberiQueryDeadlineException(
                "Kent Rehberi object lookup exceeded its execution deadline.");
        }
    }

    public async Task<KentRehberiFeatureCollection> FindNearbyAsync(
        KentRehberiNearbyCriteria criteria,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(criteria);

        var plan = KentRehberiQueryPlan.Nearby(
            criteria,
            options);

        if (TryReadCache(
                plan,
                out var cached))
        {
            return cached;
        }

        try
        {
            return await collectionSingleFlight.RunAsync(
                plan.Operation,
                plan.Fingerprint,
                plan.Deadline,
                token => ExecuteCollectionAsync(
                    plan,
                    token,
                    ct => repository.FindNearbyAsync(
                        criteria,
                        ct)),
                cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            telemetry.DeadlineExceeded(plan.Operation);
            throw new KentRehberiQueryDeadlineException(
                "Kent Rehberi nearby query exceeded its execution deadline.");
        }
    }

    private bool TryReadCache(
        KentRehberiQueryPlan plan,
        out KentRehberiFeatureCollection value)
    {
        if (!plan.Cacheable)
        {
            value = null!;
            return false;
        }

        if (cache.TryGet(
                plan.Fingerprint,
                out var cached) &&
            cached is not null)
        {
            telemetry.CacheHit(plan.Operation);
            value = cached;
            return true;
        }

        telemetry.CacheMiss(plan.Operation);
        value = null!;
        return false;
    }

    private async Task<KentRehberiFeatureCollection>
        ExecuteCollectionAsync(
            KentRehberiQueryPlan plan,
            CancellationToken cancellationToken,
            Func<CancellationToken,
                Task<KentRehberiFeatureCollection>> operation)
    {
        using var activity =
            telemetry.StartActivity(plan.Operation);
        activity?.SetTag(
            "query.cost",
            plan.EstimatedCost);
        activity?.SetTag(
            "cache.enabled",
            plan.Cacheable);

        var stopwatch = Stopwatch.StartNew();
        telemetry.RequestStarted(plan.Operation);

        try
        {
            using var lease =
                await admission.AcquireAsync(
                    plan.Operation,
                    cancellationToken)
                    .ConfigureAwait(false);

            var result = await operation(
                    cancellationToken)
                .ConfigureAwait(false);

            var report =
                integrity.ValidateCollection(result);

            if (plan.Cacheable)
            {
                cache.Set(
                    plan.Fingerprint,
                    result,
                    report.SerializedBytes,
                    plan.CacheTtl);
            }

            stopwatch.Stop();
            telemetry.RequestCompleted(
                plan.Operation,
                stopwatch.Elapsed,
                report.SerializedBytes,
                report.FeatureCount);

            activity?.SetStatus(
                ActivityStatusCode.Ok);
            activity?.SetTag(
                "result.features",
                report.FeatureCount);
            activity?.SetTag(
                "result.bytes",
                report.SerializedBytes);
            activity?.SetTag(
                "result.geometry_nodes",
                report.GeometryNodes);
            activity?.SetTag(
                "result.duplicate_ids",
                report.DuplicateObjectIds);

            return result;
        }
        catch (KentRehberiDataIntegrityException)
        {
            stopwatch.Stop();
            telemetry.IntegrityRejected(
                plan.Operation);
            telemetry.RequestFailed(
                plan.Operation,
                "integrity",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "integrity");
            throw;
        }
        catch (KentRehberiOverloadedException)
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "overloaded",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "overloaded");
            throw;
        }
        catch (OperationCanceledException)
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "cancelled",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "cancelled");
            throw;
        }
        catch
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "repository",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "repository");
            throw;
        }
    }

    private async Task<KentRehberiFeature?>
        ExecuteFeatureAsync(
            KentRehberiQueryPlan plan,
            CancellationToken cancellationToken,
            Func<CancellationToken,
                Task<KentRehberiFeature?>> operation)
    {
        using var activity =
            telemetry.StartActivity(plan.Operation);
        var stopwatch = Stopwatch.StartNew();
        telemetry.RequestStarted(plan.Operation);

        try
        {
            using var lease =
                await admission.AcquireAsync(
                    plan.Operation,
                    cancellationToken)
                    .ConfigureAwait(false);

            var result = await operation(
                    cancellationToken)
                .ConfigureAwait(false);

            long bytes = 0;
            var featureCount = 0;

            if (result is not null)
            {
                var report =
                    integrity.ValidateFeature(result);
                bytes = report.SerializedBytes;
                featureCount = 1;
            }

            stopwatch.Stop();
            telemetry.RequestCompleted(
                plan.Operation,
                stopwatch.Elapsed,
                bytes,
                featureCount);

            activity?.SetStatus(
                ActivityStatusCode.Ok);
            activity?.SetTag(
                "result.found",
                result is not null);

            return result;
        }
        catch (KentRehberiDataIntegrityException)
        {
            stopwatch.Stop();
            telemetry.IntegrityRejected(
                plan.Operation);
            telemetry.RequestFailed(
                plan.Operation,
                "integrity",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "integrity");
            throw;
        }
        catch (KentRehberiOverloadedException)
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "overloaded",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "overloaded");
            throw;
        }
        catch (OperationCanceledException)
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "cancelled",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "cancelled");
            throw;
        }
        catch
        {
            stopwatch.Stop();
            telemetry.RequestFailed(
                plan.Operation,
                "repository",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "repository");
            throw;
        }
    }
}
