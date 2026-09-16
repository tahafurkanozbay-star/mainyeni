import {DatetimeHelper} from "./DatetimeHelper";

const debugEnabled = String(import.meta.env.VITE_ENV_DEBUG ?? "").trim().toLowerCase() === "true";

export const DebugHelper = {

    Log: (_message) => {

        if (debugEnabled) {

            console.log(" --- [DEBUG-LOG] --- "+DatetimeHelper.GetFormatted(new Date()));
            console.log(_message);
            
        }
    }
}
