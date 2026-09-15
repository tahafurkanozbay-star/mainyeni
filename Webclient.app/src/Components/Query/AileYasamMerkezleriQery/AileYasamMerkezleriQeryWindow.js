import { AileYasamMerkezleriQeryBusiness } from "../../../Business/AileYasamMerkezleriQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const AileYasamMerkezleriQeryWindow = createManagedFastAccessQueryWindow({
    title: "Aile Yaşam Merkezleri",
    serviceKey: "YeniAileYasamMerkezleriQeryUrl",
    iconType: "aile yaşam merkezi",
    business: AileYasamMerkezleriQeryBusiness
});
