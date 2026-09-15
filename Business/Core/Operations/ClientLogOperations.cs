using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Business._Base;
using Business.Core.Common;
using Business.Core.Model;
using Business.Core.Context;
using Business.Core.ViewModel;
using Microsoft.EntityFrameworkCore;
using Toolbox.Text;
using Toolbox.Security.Url;

namespace Business.Core.Operations
{
    public class ClientLogOperations : _BaseOperations
    {
        private BusinessContext db;

        public ClientLogOperations(BusinessContext context)
        {
            this.db = context;
        }


        public ServiceResult Create(string logType, string browser, string os, string device, string ip, string description){

            using(db){
                var clientLog = new ClientLog()
                { 
                    Ip = ip,
                    Browser = browser,
                    Os = os,
                    Device = device,
                    LogType = logType,
                    Details = description
                };

                db.ClientLogs.Add(clientLog);
                db.SaveChanges();

                return new ServiceResult(ServiceResultType.Success,"");
            }

        }

        public ServiceResult<ClientLogViewModel> GetById(string eg)
        {

            throw new NotImplementedException();
        }

        public ServiceResult<DataList<ClientLogViewModel>> List(ClientLogSearchViewModel viewModel)
        {

            throw new NotImplementedException();
        }
        
        public List<ClientLogStatViewModel> GetStatistics()
        {
          
            using (db)
            {
                var result = db.ClientLogs.GroupBy(x => x.LogType).Select(log => new ClientLogStatViewModel
                {
                    name = log.Key,
                    value = log.Count()
                }).AsNoTracking().ToList();

                return result;
            }
        }

        public List<ClientLogStatViewModel> GetSearchStatistics()
        {
            var sql = "select cast(T.\"Details\" as json)->>'searchText' as name ,count(*) as \"count\" "
            +"FROM "+Configuration.SCHEMA_NAME+".\"ClientLogs\" T where \"LogType\"='İçerik arama' group by \"name\" order by \"count\" DESC LIMIT 20";
            using (db)
            {
                var conn = db.Database.GetDbConnection();
                conn.Open();
                var command = conn.CreateCommand();
                
                command.CommandText = sql;
                var reader = command.ExecuteReader();

                List<ClientLogStatViewModel> list=new List<ClientLogStatViewModel>();
                while (reader.Read())
                {
                    var name = reader.GetString(0);
                    var count=reader.GetInt32(1);

                    list.Add(new ClientLogStatViewModel(){
                        name= name,
                        value= count
                    });
                }

                conn.Close();

                return list;

            }  
        }

        public List<ClientLogStatViewModel> GetViewStatistics()
        {
            var sql = "select cast(T.\"Details\" as json)->>'title' as name, cast(T.\"Details\" as json)->>'eid' as id,count(*) as \"count\" "
            + "FROM " + Configuration.SCHEMA_NAME + ".\"ClientLogs\" T where \"LogType\"='İçerik görüntüleme' group by \"name\",\"id\" order by \"count\" DESC LIMIT 20";
            using (db)
            {
                var conn = db.Database.GetDbConnection();
                conn.Open();
                var command = conn.CreateCommand();
                
                command.CommandText = sql;
                var reader = command.ExecuteReader();

                List<ClientLogStatViewModel> list=new List<ClientLogStatViewModel>();
                while (reader.Read())
                {
                    var name = reader.GetString(0);
                    var id=reader.GetString(1);
                    var count=reader.GetInt32(2);
                    
                    list.Add(new ClientLogStatViewModel(){
                        id= id,
                        name= name,
                        value= count
                    });
                }

                conn.Close();

                return list;

            }  
        }
    }
}
