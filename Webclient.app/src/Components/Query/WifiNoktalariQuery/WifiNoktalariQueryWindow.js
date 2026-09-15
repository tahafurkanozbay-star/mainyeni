import { WifiNoktalariQeryBusiness } from "../../../Business/WifiNoktalariQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const WifiNoktalariQueryWindow = createManagedFastAccessQueryWindow({
    title: "Wi-Fi Noktaları",
    serviceKey: "YeniWifiNoktalariQeryUrl",
    iconType: "wifi erişim noktası",
    business: WifiNoktalariQeryBusiness
});
