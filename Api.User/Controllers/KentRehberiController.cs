using Api.User.Filters;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Api.User.KentRehberi;

[ApiController]
[Route("kent-rehberi")]
[ServiceFilter(typeof(AppRequestFilterAttribute))]
public sealed class KentRehberiController : ControllerBase
{
    private readonly IKentRehberiRepository repository;
    private readonly KentRehberiOptions options;
    private readonly ILogger<KentRehberiController> logger;

    public KentRehberiController(
        IKentRehberiRepository repository,
        KentRehberiOptions options,
        ILogger<KentRehberiController> logger)
    {
        ArgumentNullException.ThrowIfNull(repository);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);

        this.repository = repository;
        this.options = options;
        this.logger = logger;
    }

    /// <summary>
    /// Returns public Kent Rehberi records as a bounded GeoJSON FeatureCollection.
    /// The external reverse proxy is expected to expose this route as /api/kent-rehberi.
    /// </summary>
    [HttpGet]
    [AllowAnonymous]
    [Produces("application/geo+json")]
    [ProducesResponseType(typeof(KentRehberiFeatureCollection), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> Search(
        [FromQuery] string? ilce,
        [FromQuery] string? mahalle,
        [FromQuery] short? tur,
        [FromQuery(Name = "q")] string? query,
        [FromQuery] string? bbox,
        [FromQuery] int? afterObjectId,
        [FromQuery] int? limit,
        CancellationToken cancellationToken)
    {
        try
        {
            EnsureAvailable();

            var criteria = KentRehberiQueryValidation.NormalizeSearch(
                ilce,
                mahalle,
                tur,
                query,
                bbox,
                afterObjectId,
                limit,
                options);

            var result = await repository.SearchAsync(
                criteria,
                cancellationToken);

            SetPublicCacheHeaders();
            return Ok(result);
        }
        catch (KentRehberiValidationException ex)
        {
            return ValidationFailure(ex);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (IsDataAvailabilityFailure(ex))
        {
            return DataUnavailable(ex);
        }
    }

    /// <summary>
    /// Returns one public Kent Rehberi feature by objectid.
    /// </summary>
    [HttpGet("{objectId:int:min(1)}")]
    [AllowAnonymous]
    [Produces("application/geo+json")]
    [ProducesResponseType(typeof(KentRehberiFeature), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> GetByObjectId(
        [FromRoute] int objectId,
        CancellationToken cancellationToken)
    {
        try
        {
            EnsureAvailable();

            var result = await repository.GetByObjectIdAsync(
                objectId,
                cancellationToken);

            if (result is null)
            {
                Response.Headers.CacheControl = "public, max-age=15";
                return NotFound();
            }

            SetPublicCacheHeaders();
            return Ok(result);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (IsDataAvailabilityFailure(ex))
        {
            return DataUnavailable(ex);
        }
    }

    /// <summary>
    /// Returns records within radiusMeters of an EPSG:4326 coordinate,
    /// ordered by exact PostGIS geography distance.
    /// </summary>
    [HttpGet("nearby")]
    [AllowAnonymous]
    [Produces("application/geo+json")]
    [ProducesResponseType(typeof(KentRehberiFeatureCollection), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ValidationProblemDetails), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ProblemDetails), StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> Nearby(
        [FromQuery(Name = "lon")] double? longitude,
        [FromQuery(Name = "lat")] double? latitude,
        [FromQuery] double? radiusMeters,
        [FromQuery] string? ilce,
        [FromQuery] string? mahalle,
        [FromQuery] short? tur,
        [FromQuery(Name = "q")] string? query,
        [FromQuery] int? limit,
        CancellationToken cancellationToken)
    {
        try
        {
            EnsureAvailable();

            var criteria = KentRehberiQueryValidation.NormalizeNearby(
                longitude,
                latitude,
                radiusMeters,
                ilce,
                mahalle,
                tur,
                query,
                limit,
                options);

            var result = await repository.FindNearbyAsync(
                criteria,
                cancellationToken);

            SetPublicCacheHeaders();
            return Ok(result);
        }
        catch (KentRehberiValidationException ex)
        {
            return ValidationFailure(ex);
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (IsDataAvailabilityFailure(ex))
        {
            return DataUnavailable(ex);
        }
    }

    /// <summary>
    /// Returns the stable public capability envelope without exposing database topology.
    /// </summary>
    [HttpGet("capabilities")]
    [AllowAnonymous]
    [Produces("application/json")]
    [ProducesResponseType(typeof(KentRehberiCapabilities), StatusCodes.Status200OK)]
    public IActionResult Capabilities()
    {
        Response.Headers.CacheControl = "public, max-age=300";

        var filters = new List<string>
        {
            "ilce",
            "mahalle",
            "tur",
            "q",
            "bbox",
            "nearby"
        };

        if (options.ObjectIdCursorEnabled)
        {
            filters.Add("afterObjectId");
        }

        return Ok(new KentRehberiCapabilities(
            "kent-rehberi",
            4326,
            options.DefaultLimit,
            options.MaxLimit,
            options.MaxRadiusMeters,
            options.ObjectIdCursorEnabled,
            filters));
    }

    private void EnsureAvailable()
    {
        if (!options.Enabled || !repository.IsConfigured)
        {
            throw new KentRehberiDataUnavailableException(
                "Kent Rehberi data source is unavailable.");
        }
    }

    private IActionResult ValidationFailure(
        KentRehberiValidationException exception)
    {
        Response.Headers.CacheControl = "no-store";

        var problem = new ValidationProblemDetails(
            new Dictionary<string, string[]>(exception.Errors))
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "Invalid Kent Rehberi query.",
            Type = "about:blank"
        };

        return BadRequest(problem);
    }

    private IActionResult DataUnavailable(Exception exception)
    {
        Response.Headers.CacheControl = "no-store";

        logger.LogWarning(
            "Kent Rehberi data request failed with {FailureType}. TraceId: {TraceId}",
            exception.GetType().Name,
            HttpContext.TraceIdentifier);

        return Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Kent Rehberi data source is temporarily unavailable.",
            type: "about:blank");
    }

    private void SetPublicCacheHeaders()
    {
        if (options.CacheMaxAgeSeconds <= 0)
        {
            Response.Headers.CacheControl = "no-store";
            return;
        }

        var staleWhileRevalidate = Math.Min(
            options.CacheMaxAgeSeconds * 2,
            300);

        Response.Headers.CacheControl =
            $"public, max-age={options.CacheMaxAgeSeconds}, " +
            $"stale-while-revalidate={staleWhileRevalidate}";
    }

    private static bool IsDataAvailabilityFailure(Exception exception) =>
        exception is KentRehberiDataUnavailableException or
        NpgsqlException or
        TimeoutException;
}
