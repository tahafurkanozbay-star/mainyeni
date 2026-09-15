import { CultureQueryBusiness } from "../../../Business/CultureQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const CultureQueryWindow = createManagedFastAccessQueryWindow({
    title: "Kültür ve Sanat",
    serviceKey: "YeniKültürSanatQueryUrl",
    iconType: "kültür sanat",
    business: CultureQueryBusiness
});
