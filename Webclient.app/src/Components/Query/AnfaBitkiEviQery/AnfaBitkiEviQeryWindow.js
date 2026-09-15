import { AnfaBitkiEviQeryBusiness } from "../../../Business/AnfaBitkiEviQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AnfaBitkiEviQeryWindow = createManagedFastAccessQueryWindow({
    title: "ANFA Bitki Evi",
    serviceKey: "YeniAnfaBitkiEviQeryUrl",
    iconType: "anfa bitki evi",
    business: AnfaBitkiEviQeryBusiness
});
