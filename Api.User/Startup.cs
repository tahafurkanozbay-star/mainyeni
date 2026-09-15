using Api.User.Filters;
using Business.Core.Context;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.OpenApi.Models;
using System;
using System.Linq;
using System.Text.Json;

namespace api.user
{
    public class Startup
    {
        private const string CorsPolicyName = "SiteCorsPolicy";

        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            ConfigureCors(services);
            ConfigureDatabase(services);

            services.AddScoped<AppRequestFilterAttribute>();
            services.AddMemoryCache();
            services.AddControllers();
            services.AddAuthorization();
            services.AddSwaggerGen(options =>
            {
                options.IncludeXmlComments("user.api.xml");
                options.SwaggerDoc("CoreSwagger", new OpenApiInfo
                {
                    Title = "Ankara Kent Rehberi User API",
                    Version = "1.0.0",
                    Description = "Ankara Kent Rehberi User API v1"
                });
            });
        }

        private void ConfigureCors(IServiceCollection services)
        {
            var origins = Configuration.GetSection("Cors:AllowedOrigins")
                .GetChildren()
                .Select(section => section.Value?.Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Select(value => value.TrimEnd('/'))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            services.AddCors(options =>
            {
                options.AddPolicy(CorsPolicyName, policy =>
                {
                    policy.WithMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
                        .WithHeaders("Authorization", "Accept", "Content-Type", "Culture", "Origin", "User-Agent");

                    if (origins.Length > 0)
                    {
                        policy.WithOrigins(origins).AllowCredentials();
                    }
                });
            });
        }

        private void ConfigureDatabase(IServiceCollection services)
        {
            var provider = Configuration["Database:Provider"]?.Trim().ToUpperInvariant() ?? "PGSQL";
            var connectionString = Configuration.GetConnectionString("Primary")?.Trim();

            // Temporary compatibility for deployments that still inject the legacy section names.
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                var legacySection = IsProductionConfiguration()
                    ? Configuration.GetSection("DbConfigProd")
                    : Configuration.GetSection("DbConfigTest");
                connectionString = legacySection["ConnectionString"]?.Trim();
                provider = legacySection["Type"]?.Trim().ToUpperInvariant() ?? provider;
            }

            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    "Database connection string is not configured. Set ConnectionStrings__Primary in the server secret store/environment.");
            }

            if (!string.Equals(provider, "PGSQL", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Unsupported database provider '{provider}'. This deployment is hardened for PostgreSQL; migrate other providers explicitly before enabling them.");
            }

            services.AddDbContextPool<BusinessContext>(options =>
            {
                options.UseNpgsql(connectionString, npgsql =>
                {
                    npgsql.EnableRetryOnFailure(maxRetryCount: 3, maxRetryDelay: TimeSpan.FromSeconds(5), errorCodesToAdd: null);
                    npgsql.CommandTimeout(30);
                });
            });
        }

        private bool IsProductionConfiguration()
        {
            var legacyEnvironment = Configuration["Environment"]?.Trim();
            return string.Equals(legacyEnvironment, "prod", StringComparison.OrdinalIgnoreCase);
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            app.UseForwardedHeaders(new ForwardedHeadersOptions
            {
                ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
                ForwardLimit = 1
            });

            app.Use(async (context, next) =>
            {
                context.Response.OnStarting(() =>
                {
                    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
                    context.Response.Headers["X-Frame-Options"] = "DENY";
                    context.Response.Headers["Referrer-Policy"] = "no-referrer";
                    context.Response.Headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
                    context.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
                    return System.Threading.Tasks.Task.CompletedTask;
                });

                await next();
            });

            app.UseExceptionHandler(errorApp =>
            {
                errorApp.Run(async context =>
                {
                    var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
                    var logger = context.RequestServices.GetRequiredService<ILogger<Startup>>();
                    logger.LogError(exception, "Unhandled user API exception. TraceId: {TraceId}", context.TraceIdentifier);

                    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                    context.Response.ContentType = "application/problem+json";
                    await context.Response.WriteAsync(JsonSerializer.Serialize(new
                    {
                        type = "about:blank",
                        title = "Internal Server Error",
                        status = StatusCodes.Status500InternalServerError,
                        traceId = context.TraceIdentifier
                    }));
                });
            });

            app.UseRouting();
            app.UseCors(CorsPolicyName);
            app.UseAuthorization();

            var swaggerEnabled = Configuration.GetValue<bool>("Swagger:Enabled") || env.IsDevelopment();
            if (swaggerEnabled)
            {
                app.UseSwagger();
                app.UseSwaggerUI(options =>
                    options.SwaggerEndpoint("CoreSwagger/swagger.json", "Ankara Kent Rehberi User API V1"));
            }

            app.UseEndpoints(endpoints => endpoints.MapControllers());
        }
    }
}
