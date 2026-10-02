using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace Api.Core.Platform.Lifecycle
{
    public sealed class RequestLifecycleDrainService : IHostedService
    {
        private readonly RequestLifecycleCoordinator _coordinator; private readonly ApiPlatformOptions _options; private readonly ILogger<RequestLifecycleDrainService> _logger;
        public RequestLifecycleDrainService(RequestLifecycleCoordinator coordinator, ApiPlatformOptions options, ILogger<RequestLifecycleDrainService> logger)
        { _coordinator = coordinator ?? throw new ArgumentNullException(nameof(coordinator)); _options = options ?? throw new ArgumentNullException(nameof(options)); _logger = logger ?? throw new ArgumentNullException(nameof(logger)); }
        public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (!_options.Lifecycle.Enabled) return;
            _coordinator.BeginDrain();
            var before = _coordinator.Snapshot;
            if (before.DrainBlockingInFlight == 0) { _logger.LogInformation("Request lifecycle drain completed immediately. InFlight={InFlight} Accepted={Accepted} Completed={Completed}", before.InFlight, before.Accepted, before.Completed); return; }
            using (var configuredDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(_options.Lifecycle.ShutdownDrainSeconds)))
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, configuredDeadline.Token))
            {
                var drained = await _coordinator.WaitForDrainAsync(deadline.Token).ConfigureAwait(false);
                var after = _coordinator.Snapshot;
                if (drained) { _logger.LogInformation("Request lifecycle drain completed. Remaining={Remaining} Accepted={Accepted} Completed={Completed} Rejected={Rejected}", after.DrainBlockingInFlight, after.Accepted, after.Completed, after.RejectedDuringDrain); return; }
                _logger.LogWarning("Request lifecycle drain deadline elapsed. Remaining={Remaining} InFlight={InFlight} Accepted={Accepted} Completed={Completed} Rejected={Rejected}", after.DrainBlockingInFlight, after.InFlight, after.Accepted, after.Completed, after.RejectedDuringDrain);
            }
        }
    }
}
