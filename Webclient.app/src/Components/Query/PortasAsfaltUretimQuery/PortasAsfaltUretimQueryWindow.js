import { PortasAsfaltUretimQeryBusiness } from "../../../Business/PortasAsfaltUretimQeryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const PortasAsfaltUretimQueryWindow = createManagedFastAccessQueryWindow({
    title: "PORTAŞ Asfalt Üretim",
    serviceKey: "YeniPortasAsfaltUretimQeryUrl",
    iconType: "portas asfalt",
    business: PortasAsfaltUretimQeryBusiness
});
