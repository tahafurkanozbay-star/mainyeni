import { HalkEkmekQueryBusiness } from "../../../Business/HalkEkmekQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const HalkEkmekQueryWindow = createManagedFastAccessQueryWindow({
    title: "Halk Ekmek Satış Noktaları",
    serviceKey: "YeniHalkEkmekSatisNoktalariQeryUrl",
    iconType: "halk ekmek",
    business: HalkEkmekQueryBusiness
});
