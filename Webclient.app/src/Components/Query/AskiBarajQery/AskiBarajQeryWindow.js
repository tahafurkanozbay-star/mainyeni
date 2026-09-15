import { AskiBarajQeryBusiness } from "../../../Business/AskiBarajQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AskiBarajQeryWindow = createManagedFastAccessQueryWindow({
    title: "ASKİ Barajları",
    serviceKey: "YeniAskiBarajQeryUrl",
    iconType: "baraj",
    business: AskiBarajQeryBusiness
});
