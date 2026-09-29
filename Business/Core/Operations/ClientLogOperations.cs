using System;
using System.Collections.Generic;
using System.Data;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Model;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;

namespace Business.Core.Operations
{
    public class ClientLogOperations : _BaseOperations
    {
        private const int MaxLogTypeLength = 128;
        private const int MaxClientMetadataLength = 512;
        private const int MaxIpLength = 128;
        private const int MaxDetailsLength = 32 * 1024;
        private const int StatisticsLimit = 20;

        private readonly BusinessContext db;

        public ClientLogOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
        }

        public ServiceResult Create(
            string logType,
            string browser,
            string os,
            string device,
            string ip,
            string description) =>
            CreateAsync(logType, browser, os, device, ip, description).GetAwaiter().GetResult();

        public async Task<ServiceResult> CreateAsync(
            string logType,
            string browser,
            string os,
            string device,
            string ip,
            string description,
            CancellationToken cancellationToken = default)
        {
            if (!TryNormalizeRequired(logType, MaxLogTypeLength, out var normalizedLogType) ||
                !TryNormalizeOptional(browser, MaxClientMetadataLength, out var normalizedBrowser) ||
                !TryNormalizeOptional(os, MaxClientMetadataLength, out var normalizedOs) ||
                !TryNormalizeOptional(device, MaxClientMetadataLength, out var normalizedDevice) ||
                !TryNormalizeOptional(ip, MaxIpLength, out var normalizedIp) ||
                !TryNormalizeOptional(description, MaxDetailsLength, out var normalizedDescription))
            {
                return Error("İstemci günlük girdisi geçersiz");
            }

            cancellationToken.ThrowIfCancellationRequested();

            var clientLog = new ClientLog
            {
                Ip = normalizedIp,
                Browser = normalizedBrowser,
                Os = normalizedOs,
                Device = normalizedDevice,
                LogType = normalizedLogType,
                Details = normalizedDescription
            };

            await db.ClientLogs.AddAsync(clientLog, cancellationToken).ConfigureAwait(false);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

            return new ServiceResult(ServiceResultType.Success, string.Empty);
        }

        public ServiceResult<ClientLogViewModel> GetById(string eg)
        {
            throw new NotImplementedException();
        }

        public ServiceResult<DataList<ClientLogViewModel>> List(ClientLogSearchViewModel viewModel)
        {
            throw new NotImplementedException();
        }

        public List<ClientLogStatViewModel> GetStatistics() =>
            GetStatisticsAsync().GetAwaiter().GetResult();

        public async Task<List<ClientLogStatViewModel>> GetStatisticsAsync(
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();

            return await db.ClientLogs
                .AsNoTracking()
                .GroupBy(x => x.LogType)
                .Select(log => new ClientLogStatViewModel
                {
                    name = log.Key,
                    value = log.Count()
                })
                .OrderByDescending(x => x.value)
                .ThenBy(x => x.name)
                .Take(StatisticsLimit)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
        }

        public List<ClientLogStatViewModel> GetSearchStatistics() =>
            GetSearchStatisticsAsync().GetAwaiter().GetResult();

        public Task<List<ClientLogStatViewModel>> GetSearchStatisticsAsync(
            CancellationToken cancellationToken = default) =>
            ReadJsonStatisticsAsync(
                "İçerik arama",
                "searchText",
                includeId: false,
                cancellationToken);

        public List<ClientLogStatViewModel> GetViewStatistics() =>
            GetViewStatisticsAsync().GetAwaiter().GetResult();

        public Task<List<ClientLogStatViewModel>> GetViewStatisticsAsync(
            CancellationToken cancellationToken = default) =>
            ReadJsonStatisticsAsync(
                "İçerik görüntüleme",
                "title",
                includeId: true,
                cancellationToken);

        private async Task<List<ClientLogStatViewModel>> ReadJsonStatisticsAsync(
            string logType,
            string nameProperty,
            bool includeId,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // Schema and JSON property identifiers are application constants, never request input.
            // jsonb extraction is guarded with jsonb_typeof so non-object JSON does not become a result row.
            var schema = QuoteIdentifier(Configuration.SCHEMA_NAME);
            var idProjection = includeId
                ? ", (T.\"Details\"::jsonb)->>'eid' AS id"
                : string.Empty;
            var idGroup = includeId ? ", id" : string.Empty;
            var sql = $@"
SELECT (T.\"Details\"::jsonb)->>'{nameProperty}' AS name{idProjection}, COUNT(*) AS count
FROM {schema}.\"ClientLogs\" T
WHERE T.\"LogType\" = @logType
  AND T.\"Details\" IS NOT NULL
  AND jsonb_typeof(T.\"Details\"::jsonb) = 'object'
GROUP BY name{idGroup}
ORDER BY count DESC, name ASC
LIMIT {StatisticsLimit}";

            var connection = db.Database.GetDbConnection();
            var shouldClose = connection.State != ConnectionState.Open;

            try
            {
                if (shouldClose)
                {
                    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
                }

                await using var command = connection.CreateCommand();
                command.CommandText = sql;

                var parameter = command.CreateParameter();
                parameter.ParameterName = "@logType";
                parameter.Value = logType;
                command.Parameters.Add(parameter);

                await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                var list = new List<ClientLogStatViewModel>(StatisticsLimit);

                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    if (reader.IsDBNull(0))
                    {
                        continue;
                    }

                    var name = reader.GetString(0);
                    var idOrdinal = includeId ? 1 : -1;
                    var countOrdinal = includeId ? 2 : 1;

                    list.Add(new ClientLogStatViewModel
                    {
                        id = includeId && !reader.IsDBNull(idOrdinal) ? reader.GetString(idOrdinal) : null,
                        name = name,
                        value = Convert.ToInt32(reader.GetValue(countOrdinal))
                    });
                }

                return list;
            }
            finally
            {
                if (shouldClose && connection.State != ConnectionState.Closed)
                {
                    await connection.CloseAsync().ConfigureAwait(false);
                }
            }
        }

        private static string QuoteIdentifier(string identifier)
        {
            if (string.IsNullOrWhiteSpace(identifier))
            {
                throw new InvalidOperationException("Database schema is not configured.");
            }

            return $"\"{identifier.Replace("\"", "\"\"")}\"";
        }

        private static bool TryNormalizeRequired(string? value, int maxLength, out string normalized)
        {
            normalized = value?.Trim() ?? string.Empty;
            return normalized.Length > 0 && normalized.Length <= maxLength;
        }

        private static bool TryNormalizeOptional(string? value, int maxLength, out string normalized)
        {
            normalized = value?.Trim() ?? string.Empty;
            return normalized.Length <= maxLength;
        }

        private static ServiceResult Error(string message) =>
            new ServiceResult(ServiceResultType.Error, message);
    }
}
