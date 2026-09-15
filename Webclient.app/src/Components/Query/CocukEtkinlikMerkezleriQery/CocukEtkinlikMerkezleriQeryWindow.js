import { CocukEtkinlikMerkezleriQeryBusiness } from "../../../Business/CocukEtkinlikMerkezleriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const CocukEtkinlikMerkezleriQeryWindow = createManagedFastAccessQueryWindow({
    title: "Çocuk Etkinlik Merkezleri",
    serviceKey: "YeniCocukEtkinlikMerkezleriQeryUrl",
    iconType: "çocuk etkinlik merkezi",
    business: CocukEtkinlikMerkezleriQeryBusiness
});
