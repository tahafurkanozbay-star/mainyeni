import { ParklarQeryBusiness } from "../../../Business/ParklarQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const ParklarQueryWindow = createManagedFastAccessQueryWindow({
    title: "Parklar",
    serviceKey: "YeniParklarQeryUrl",
    iconType: "park",
    business: ParklarQeryBusiness
});
