import { SegmenSuFabrikalarıQeryBusiness } from "../../../Business/SegmenSuFabrikalarıQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const SegmenSuFabrikalarıQueryWindow = createManagedFastAccessQueryWindow({
    title: "Seğmen Su Fabrikaları",
    serviceKey: "YeniSegmenSuFabrikalarıQeryUrl",
    iconType: "segmen su",
    business: SegmenSuFabrikalarıQeryBusiness
});
