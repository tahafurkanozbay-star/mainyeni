using System;
using System.Threading.Tasks;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;

namespace Api.User.Extensions.Controllers
{
    public class TkgmController : _BaseUserApiController
    {
        private readonly GisTkgmOperations gisTkgmOperations;

        public TkgmController(BusinessContext context)
        {
            dbContext = context;
            gisTkgmOperations = new GisTkgmOperations(context);
        }

        /// <summary>Gets TKGM districts for the given city id.</summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Districts/{cityId}")]
        public async Task<string> Districts(int cityId)
        {
            try
            {
                if (!ValidateAuthToken()) return null;
                return await gisTkgmOperations.DistrictsAsync(cityId, HttpContext.RequestAborted);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested) { throw; }
            catch (Exception ex) { handleExceptionResult(ex); return ex.Message; }
        }

        /// <summary>Gets TKGM neighbourhoods for the given district id.</summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Nbhoods/{districtId}")]
        public async Task<string> Nbhoods(int districtId)
        {
            try
            {
                if (!ValidateAuthToken()) return null;
                return await gisTkgmOperations.NbhoodsAsync(districtId, HttpContext.RequestAborted);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested) { throw; }
            catch (Exception ex) { handleExceptionResult(ex); return ex.Message; }
        }

        /// <summary>Gets one TKGM parcel.</summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Parcel/{districtId}/{nbhoodId}/{cityblock}/{parcel}")]
        public async Task<string> Parcel(int districtId, int nbhoodId, int cityblock, int parcel)
        {
            try
            {
                if (!ValidateAuthToken()) return null;
                return await gisTkgmOperations.ParcelAsync(districtId, nbhoodId, cityblock, parcel, HttpContext.RequestAborted);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested) { throw; }
            catch (Exception ex) { handleExceptionResult(ex); return ex.Message; }
        }
    }
}
