import { TeknolojiMerkezleriQueryBusiness } from "../../../Business/TeknolojiMerkezleriQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const TeknolojiMerkezleriQueryWindow = createManagedFastAccessQueryWindow({
    title: "Teknoloji Merkezleri",
    serviceKey: "YeniTeknolojiMerkezleriQueryUrl",
    iconType: "teknoloji merkezi",
    business: TeknolojiMerkezleriQueryBusiness
});
