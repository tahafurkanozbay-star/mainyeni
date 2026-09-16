import { runtimeConfig } from "../platform/config/runtimeConfig";
import { DatetimeHelper } from "./DatetimeHelper";

export const DebugHelper = {

    Log: (_message) => {

        if (runtimeConfig.environment !== "production") {

            console.log(" --- [DEBUG-LOG] --- " + DatetimeHelper.GetFormatted(new Date()));
            console.log(_message);

        }
    }
}