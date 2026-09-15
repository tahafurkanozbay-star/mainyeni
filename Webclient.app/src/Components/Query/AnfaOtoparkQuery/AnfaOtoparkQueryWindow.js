import { AnfaOtoparkQeryBusiness } from "../../../Business/AnfaOtoparkQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AnfaOtoparkQueryWindow = createManagedFastAccessQueryWindow({
    title: "ANFA Otopark",
    serviceKey: "YeniAnfaOtoparkQeryUrl",
    iconType: "anfa otopark",
    business: AnfaOtoparkQeryBusiness
});
