import { EgoKartSatisNoktalariQueryBusiness } from "../../../Business/EgoKartSatisNoktalariQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoKartSatisNoktalariQueryWindow = createManagedFastAccessQueryWindow({
    title: "EGO Kart Satış Noktaları",
    serviceKey: "YeniEgoKartSatisNoktalariQueryUrl",
    iconType: "kart satış noktası",
    business: EgoKartSatisNoktalariQueryBusiness
});
