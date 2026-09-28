using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Business._Base;
using Business.Core.Common;
using Business.Core.Context;
using Business.Core.Resources;
using Business.Extensions.Gis.Model;
using Business.Extensions.Integrations.Pod.AEOServiceReference;
using Business.Extensions.Integrations.ViewModel;

namespace Business.Extensions.Integrations.Operations
{
    public class HatDurakBilgiOperations : _BaseOperations
    {
        private const int MaxLineNumberLength = 32;
        private readonly BusinessContext db;
        private readonly HatDurakBilgiServisSoap client;
        private readonly string token = Configuration.EGO_SERVICE_TOKEN;

        public HatDurakBilgiOperations(BusinessContext context)
        {
            db = context ?? throw new ArgumentNullException(nameof(context));
            client = new HatDurakBilgiServisSoapClient(HatDurakBilgiServisSoapClient.EndpointConfiguration.HatDurakBilgiServisSoap);
        }

        public async Task<ServiceResult<List<Hat>>> ActiveLines(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var results = await client.AktifHatlarAsync(token).WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new ServiceResult<List<Hat>>(ServiceResultType.Success, results.ToList());
        }

        public async Task<ServiceResult<List<HatGuzergahDuraklar>>> ActiveLineInfos(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var results = await client.AktifHatlarBilgisiAsync(token).WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new ServiceResult<List<HatGuzergahDuraklar>>(ServiceResultType.Success, results.ToList());
        }

        public async Task<ServiceResult<List<MasterDurak>>> ActiveStops(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var results = await client.AktifDuraklarAsync(token).WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new ServiceResult<List<MasterDurak>>(ServiceResultType.Success, results.ToList());
        }

        public async Task<ServiceResult<List<DuraktanGecenHatlar>>> LinesOfStop(CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var results = await client.DuraktanGecenHatlarAsync(token).WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new ServiceResult<List<DuraktanGecenHatlar>>(ServiceResultType.Success, results.ToList());
        }

        public async Task<ServiceResult<HatGuzergahDuraklar>> LineInfo(string lineNumber, CancellationToken cancellationToken = default)
        {
            var canonicalLineNumber = ValidateLineNumber(lineNumber);
            cancellationToken.ThrowIfCancellationRequested();
            var result = await client.HatBilgisiAsync(token, canonicalLineNumber).WaitAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new ServiceResult<HatGuzergahDuraklar>(ServiceResultType.Success, result);
        }

        public static string ValidateLineNumber(string lineNumber)
        {
            if (string.IsNullOrWhiteSpace(lineNumber))
                throw new ArgumentException("EGO line number must not be empty.", nameof(lineNumber));

            var value = lineNumber.Trim();
            if (value.Length > MaxLineNumberLength)
                throw new ArgumentException("EGO line number exceeds the supported length.", nameof(lineNumber));

            foreach (var character in value)
            {
                if (!(char.IsAsciiLetterOrDigit(character) || character is '-' or '/' or '.'))
                    throw new ArgumentException("EGO line number contains an unsupported character.", nameof(lineNumber));
            }

            return value;
        }
    }
}
