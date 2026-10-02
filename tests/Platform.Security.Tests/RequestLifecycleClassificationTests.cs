using Api.Core.Platform;
using Api.Core.Platform.Lifecycle;
using Microsoft.AspNetCore.Http;
using System;
using Xunit;

namespace Platform.Security.Tests
{
    public sealed class RequestLifecycleClassificationTests
    {
        [Theory]
        [InlineData("GET", "/api/layers/export")]
        [InlineData("HEAD", "/api/layers/export")]
        [InlineData("POST", "/api/layers/export")]
        [InlineData("POST", "/api/config/import")]
        [InlineData("PUT", "/api/bulk/jobs")]
        [InlineData("GET", "/API/LAYERS/EXPORT")]
        [InlineData("POST", "//api//import//jobs")]
        public void ExactBulkSegment_IsBulkRegardlessOfExecutionVerb(string method, string path)
        {
            var budget = Resolve(method, path);

            Assert.Equal(RequestWorkloadClass.Bulk, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(60), budget.Timeout);
            Assert.False(budget.ExemptFromDrain);
        }

        [Theory]
        [InlineData("GET", "/api/exported")]
        [InlineData("GET", "/api/importer")]
        [InlineData("GET", "/api/bulkhead")]
        [InlineData("GET", "/api/layers/myexport")]
        [InlineData("GET", "/api/layers/import-v2")]
        public void BulkKeywordSubstring_DoesNotEscalateInteractiveReadBudget(string method, string path)
        {
            var budget = Resolve(method, path);

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(20), budget.Timeout);
        }

        [Theory]
        [InlineData("POST", "/api/exported")]
        [InlineData("PATCH", "/api/importer/1")]
        [InlineData("DELETE", "/api/bulkhead/1")]
        public void BulkKeywordSubstring_DoesNotEscalateMutationBudget(string method, string path)
        {
            var budget = Resolve(method, path);

            Assert.Equal(RequestWorkloadClass.Mutation, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(30), budget.Timeout);
        }

        [Theory]
        [InlineData("/api/export")]
        [InlineData("/api/import")]
        [InlineData("/api/bulk/jobs")]
        public void OptionsPreflight_RemainsInteractiveReadForBulkRoute(string path)
        {
            var budget = Resolve("OPTIONS", path);

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(20), budget.Timeout);
        }

        [Theory]
        [InlineData("GET")]
        [InlineData("HEAD")]
        [InlineData("OPTIONS")]
        public void OrdinarySafeMethod_UsesInteractiveReadBudget(string method)
        {
            var budget = Resolve(method, "/api/layers");

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(20), budget.Timeout);
            Assert.False(budget.ExemptFromDrain);
        }

        [Theory]
        [InlineData("POST")]
        [InlineData("PUT")]
        [InlineData("PATCH")]
        [InlineData("DELETE")]
        public void OrdinaryMutationVerb_UsesMutationBudget(string method)
        {
            var budget = Resolve(method, "/api/layers/1");

            Assert.Equal(RequestWorkloadClass.Mutation, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(30), budget.Timeout);
            Assert.False(budget.ExemptFromDrain);
        }

        [Theory]
        [InlineData("/health/live")]
        [InlineData("/HEALTH/LIVE")]
        [InlineData("/health/ready")]
        [InlineData("/HEALTH/READY")]
        public void ExactHealthPath_IsDrainExempt(string path)
        {
            var budget = Resolve("GET", path);

            Assert.Equal(RequestWorkloadClass.Health, budget.WorkloadClass);
            Assert.Equal(TimeSpan.FromSeconds(5), budget.Timeout);
            Assert.True(budget.ExemptFromDrain);
        }

        [Theory]
        [InlineData("/health/live/extra")]
        [InlineData("/health/readiness")]
        [InlineData("/api/health/ready")]
        public void HealthLikePath_IsNotDrainExempt(string path)
        {
            var budget = Resolve("GET", path);

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
            Assert.False(budget.ExemptFromDrain);
        }

        [Fact]
        public void QueryStringCannotChangeWorkloadClass()
        {
            var options = CreateOptions();
            var policy = new RequestLifecyclePolicy(options);
            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/api/layers";
            context.Request.QueryString = new QueryString("?operation=export&path=/bulk");

            var budget = policy.Resolve(context);

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
        }

        [Fact]
        public void CustomHealthPaths_AreResolvedFromCanonicalConfiguration()
        {
            var options = CreateOptions();
            options.Health.LivenessPath = "/internal/live";
            options.Health.ReadinessPath = "/internal/ready";
            var policy = new RequestLifecyclePolicy(options);
            var context = new DefaultHttpContext();
            context.Request.Method = "GET";
            context.Request.Path = "/internal/ready";

            var budget = policy.Resolve(context);

            Assert.Equal(RequestWorkloadClass.Health, budget.WorkloadClass);
            Assert.True(budget.ExemptFromDrain);
        }

        [Fact]
        public void EmptyPath_RemainsDeterministicInteractiveRead()
        {
            var budget = Resolve("GET", string.Empty);

            Assert.Equal(RequestWorkloadClass.InteractiveRead, budget.WorkloadClass);
        }

        [Fact]
        public void NullContext_IsRejected()
        {
            var policy = new RequestLifecyclePolicy(CreateOptions());

            Assert.Throws<ArgumentNullException>(() => policy.Resolve(null!));
        }

        private static RequestLifecycleBudget Resolve(string method, string path)
        {
            var policy = new RequestLifecyclePolicy(CreateOptions());
            var context = new DefaultHttpContext();
            context.Request.Method = method;
            context.Request.Path = path;
            return policy.Resolve(context);
        }

        private static ApiPlatformOptions CreateOptions() => new ApiPlatformOptions();
    }
}
