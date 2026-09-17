import {DatetimeHelper} from "./DatetimeHelper";
import { runtimeConfig } from "../platform/config/runtimeConfig";

const debugEnabled = String(import.meta.env.VITE_ENV_DEBUG ?? "").trim().toLowerCase() === "true";

export const DebugHelper = {

    Log: (_message) => {

        if (runtimeConfig.features.debugLogging || debugEnabled) {

            console.log(" --- [DEBUG-LOG] --- "+DatetimeHelper.GetFormatted(new Date()));
            console.log(_message);
            
        }
    }
}
