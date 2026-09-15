import {DatetimeHelper} from "./DatetimeHelper";

export const DebugHelper = {

    Log: (_message) => {

        if (process.env.REACT_APP_ENV_DEBUG) {

            console.log(" --- [DEBUG-LOG] --- "+DatetimeHelper.GetFormatted(new Date()));
            console.log(_message);
            
        }
    }
}