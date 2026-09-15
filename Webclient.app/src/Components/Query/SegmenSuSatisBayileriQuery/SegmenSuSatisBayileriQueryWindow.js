import { SegmenSuSatisBayileriQeryBusiness } from "../../../Business/SegmenSuSatisBayileriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const SegmenSuSatisBayileriQueryWindow = createManagedFastAccessQueryWindow({
    title: "Seğmen Su Satış Bayileri",
    serviceKey: "YeniSegmenSuSatisBayileriQeryUrl",
    iconType: "segmen su",
    business: SegmenSuSatisBayileriQeryBusiness
});
