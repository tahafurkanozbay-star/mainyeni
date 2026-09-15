import { AskiSumatikQueryBusiness } from "../../../Business/AskiSumatikQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiSumatikQeryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Sumatik",
    serviceKey: "YeniAskiSumatikQueryUrl",
    iconType: "sumatik",
    business: AskiSumatikQueryBusiness
});
