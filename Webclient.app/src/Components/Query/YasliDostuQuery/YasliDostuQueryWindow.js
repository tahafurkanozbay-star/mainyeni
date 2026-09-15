import { YasliDostuQueryBusiness } from "../../../Business/YasliDostuQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const YasliDostuQueryWindow = createManagedFastAccessQueryWindow({
    title: "Yaşlı Dostu Uygulamalar",
    serviceKey: "YeniYasliDostuQueryUrl",
    iconType: "yaşlı dostu uygulama",
    business: YasliDostuQueryBusiness
});
