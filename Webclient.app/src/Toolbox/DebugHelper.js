import {DatetimeHelper} from "./DatetimeHelper";
import { runtimeConfig } from "../platform/config/runtimeConfig";

export const DebugHelper = {

    Log: (_message) => {

        if (runtimeConfig.features.debugLogging) {

            console.log(" --- [DEBUG-LOG] --- "+DatetimeHelper.GetFormatted(new Date()));
            console.log(_message);
            
        }
    }
}
