using System;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

public interface IKentRehberiTypeCatalogService
{
    bool IsConfigured { get; }

    Task<KentRehberiTypeCatalog> GetAsync(
        CancellationToken cancellationToken);
}

public sealed class KentRehberiTypeCatalogService :
    IKentRehberiTypeCatalogService
{
    private const string Operation = "type-catalog";
    private const string Fingerprint = "kent-rehberi:type-catalog:v1";

    private readonly IKentRehberiRepository repository;
    private readonly KentRehberiOptions options;
    private readonly KentRehberiTypeCatalogCache cache;
    private readonly KentRehberiAdmissionController admission;
    private readonly KentRehberiSingleFlight<KentRehberiTypeCatalog> singleFlight;
    private readonly KentRehberiTypeCatalogIntegrityGuard integrity;
    private readonly KentRehberiTelemetry telemetry;

    public KentRehberiTypeCatalogService(
        IKentRehberiRepository repository,
        KentRehberiOptions options,
        KentRehberiTypeCatalogCache cache,
        KentRehberiAdmissionController admission,
        KentRehberiSingleFlight<KentRehberiTypeCatalog> singleFlight,
        KentRehberiTypeCatalogIntegrityGuard integrity,
        KentRehberiTelemetry telemetry)
    {
        ArgumentNullException.ThrowIfNull(repository);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(cache);
        ArgumentNullException.ThrowIfNull(admission);
        ArgumentNullException.ThrowIfNull(singleFlight);
        ArgumentNullException.ThrowIfNull(integrity);
        ArgumentNullException.ThrowIfNull(telemetry);

        this.repository = repository;
        this.options = options;
        this.cache = cache;
        this.admission = admission;
        this.singleFlight = singleFlight;
        this.integrity = integrity;
        this.telemetry = telemetry;
    }

    public bool IsConfigured => repository.IsConfigured;

    public async Task<KentRehberiTypeCatalog> GetAsync(
        CancellationToken cancellationToken)
    {
        if (cache.TryGet(out var cached))
        {
            telemetry.CacheHit(Operation);
            return cached;
        }

        telemetry.CacheMiss(Operation);

        try
        {
            return await singleFlight.RunAsync(
                    Operation,
                    Fingerprint,
                    TimeSpan.FromMilliseconds(
                        options.QueryDeadlineMilliseconds),
                    ExecuteAsync,
                    cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested)
        {
            telemetry.DeadlineExceeded(Operation);
            throw new KentRehberiQueryDeadlineException(
                "Kent Rehberi type catalog exceeded its execution deadline.");
        }
    }

    private async Task<KentRehberiTypeCatalog> ExecuteAsync(
        CancellationToken cancellationToken)
    {
        if (cache.TryGet(out var cached))
        {
            telemetry.CacheHit(Operation);
            return cached;
        }

        using var activity = telemetry.StartActivity(Operation);
        var stopwatch = Stopwatch.StartNew();
        telemetry.RequestStarted(Operation);

        try
        {
            using var lease =
                await admission.AcquireAsync(
                        Operation,
                        cancellationToken)
                    .ConfigureAwait(false);

            var result =
                await repository.GetTypeCatalogAsync(
                        cancellationToken)
                    .ConfigureAwait(false);

            var report = integrity.Validate(result);
            cache.Set(result);

            stopwatch.Stop();
            telemetry.RequestCompleted(
                Operation,
                stopwatch.Elapsed,
                report.SerializedBytes,
                report.TypeCount);

            activity?.SetStatus(ActivityStatusCode.Ok);
            activity?.SetTag(
                "result.types",
                report.TypeCount);
            activity?.SetTag(
                "result.samples",
                report.SampleCount);
            activity?.SetTag(
                "result.bytes",
                report.SerializedBytes);

            return result;
        }
        catch (KentRehberiDataIntegrityException)
        {
            stopwatch.Stop();
            telemetry.IntegrityRejected(Operation);
            telemetry.RequestFailed(
                Operation,
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
                Operation,
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
                Operation,
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
                Operation,
                "repository",
                stopwatch.Elapsed);
            activity?.SetStatus(
                ActivityStatusCode.Error,
                "repository");
            throw;
        }
    }
}
