import { AnfaKafelerQeryBusiness } from "../../../Business/AnfaKafelerQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AnfaKafelerQeryWindow = createManagedFastAccessQueryWindow({
    title: "ANFA Kafeler",
    serviceKey: "YeniAnfaKafelerQeryUrl",
    iconType: "anfa kafe",
    business: AnfaKafelerQeryBusiness
});
