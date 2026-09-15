export const Constants = {
    ServiceResultType: {
        Success: 10,
        Error: 20
    },

    Session:{
        SessionObjectTitle:"_cviaıq34gmx",
        Pk: "_xkcdi9azmxku"
    },

    ExportTypes:{
        CSV:"csv",
        XLS:"xlsx",
    },
    
    MessageTypes:{
        Success: 10,
        Error: 20,
        Warning: 30,
        Info: 40,
    },

    LayerTypes:[
        ["MapImageLayer",0],
        ["FeatureLayer",2],
        ["WMS",3]
    ],
    

    AccountTypes:{
        LDAP:1,
        EXTERNAL:2,
    },

    ActionTypes:{
        API:1,
        CLIENT:2,
    },
    
    LoadingStatus:{
        NONE:0,
        SUBMITTED:1,
        FAILED:2,
        LOADING:3,
    },

    SessionStatus:{
        UNDECIDED:0,
        NOT_EXISTS:1,
        EXISTS:2
    }
    
};
