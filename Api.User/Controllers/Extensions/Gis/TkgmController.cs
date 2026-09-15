using System;
using Api.Core.Base;
using Api.User.Filters;
using Business.Core.Context;
using Business.Extensions.Gis.Operations;
using Microsoft.AspNetCore.Mvc;
using RestSharp;

namespace Api.User.Extensions.Controllers
{
    public class TkgmController : _BaseUserApiController
    {
        private GisTkgmOperations gisTkgmOperations;

        public TkgmController(BusinessContext context)
        {
            this.dbContext = context;
            gisTkgmOperations = new GisTkgmOperations(context);
        }


        /// <summary>
        /// Gets the list for tkgm districts with the given city id
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Districts/{cityId}")]
        public string Districts(int cityId)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return null;
                }

                return gisTkgmOperations.Districts(cityId);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return ex.Message;
            }
        }



        /// <summary>
        /// Gets the list for tkgm nbhoods with the given district id
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Nbhoods/{districtId}")]
        public string Nbhoods(int districtId)
        {
            try
            {
                if (!ValidateAuthToken())
                {
                    return null;
                }


                return gisTkgmOperations.Nbhoods(districtId);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return ex.Message;
            }
        }


        /// <summary>
        /// Gets the list for tkgm nbhoods with the given district id
        /// </summary>
        [HttpGet]
        [ServiceFilter(typeof(AppRequestFilterAttribute))]
        [Route("Gis/[controller]/Parcel/{districtId}/{nbhoodId}/{cityblock}/{parcel}")]
        public string Parcel(int districtId, int nbhoodId, int cityblock, int parcel)
        {
            try
            {

                if (!ValidateAuthToken())
                {
                    return null;
                }


                return gisTkgmOperations.Parcel(districtId, nbhoodId, cityblock, parcel);
            }
            catch (Exception ex)
            {
                handleExceptionResult(ex);
                return ex.Message;
            }
        }

    }
}
