import { AskiAtıkSuTesisleriQeryBusiness } from "../../../Business/AskiAtıkSuTesisleriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiAtıkSuTesisleriQeryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Atık Su Tesisleri",
    serviceKey: "YeniAskiAtıkSuTesisleriQeryUrl",
    iconType: "atıksu tesisi",
    business: AskiAtıkSuTesisleriQeryBusiness
});
