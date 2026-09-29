using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;

namespace Api.User.Platform;

/// <summary>
/// Applies the GIS proxy body budget at the server feature boundary, before the controller
/// allocates or buffers request content. This is intentionally route-scoped: unrelated API
/// endpoints retain the framework/server request-size policy.
/// </summary>
public sealed class GisProxyRequestBodyLimitMiddleware
{
    public const long MaxRequestBodyBytes = 5L * 1024L * 1024L;

    private static readonly PathString ProxyPath = new("/Gis/Proxy");
    private readonly RequestDelegate _next;

    public GisProxyRequestBodyLimitMiddleware(RequestDelegate next)
    {
        _next = next ?? throw new ArgumentNullException(nameof(next));
    }

    public async Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);

        if (!IsProxyRequest(context.Request))
        {
            await _next(context);
            return;
        }

        if (context.Request.ContentLength is > MaxRequestBodyBytes)
        {
            await RejectAsync(context);
            return;
        }

        var limitFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (limitFeature is { IsReadOnly: false })
        {
            // Kestrel enforces this while reading both Content-Length and chunked bodies.
            // The controller's existing post-read byte check remains defense in depth.
            limitFeature.MaxRequestBodySize = MaxRequestBodyBytes;
        }

        await _next(context);
    }

    public static bool IsProxyRequest(HttpRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!request.Path.Equals(ProxyPath, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return HttpMethods.IsPost(request.Method) || HttpMethods.IsGet(request.Method);
    }

    private static async Task RejectAsync(HttpContext context)
    {
        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
        context.Response.ContentType = "text/plain; charset=utf-8";
        await context.Response.WriteAsync(
            "Proxy request body is too large.",
            context.RequestAborted);
    }
}
