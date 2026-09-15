import { BelmekBeltekQeryBusiness } from "../../../Business/BelmekBeltekQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const BelmekBeltekQeryWindow = createManagedFastAccessQueryWindow({
    title: "BELMEK / BELTEK",
    serviceKey: "YeniBelmekBeltekQeryUrl",
    iconType: "belmek",
    business: BelmekBeltekQeryBusiness
});
