import { EgoKartDolumNoktalariQeryBusiness } from "../../../Business/EgoKartDolumNoktalariQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const EgoKartDolumNoktalariQeryWindow = createManagedFastAccessQueryWindow({
    title: "EGO Kart Dolum Noktaları",
    serviceKey: "YeniEgoKartDolumNoktalariQeryUrl",
    iconType: "kart dolum noktası",
    business: EgoKartDolumNoktalariQeryBusiness
});
