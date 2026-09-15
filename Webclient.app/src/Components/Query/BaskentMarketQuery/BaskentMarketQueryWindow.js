import { BaskentMarketQueryBusiness } from "../../../Business/BaskentMarketQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const BaskentMarketQueryWindow = createManagedFastAccessQueryWindow({
    title: "Başkent Market",
    serviceKey: "YeniBaskentMarketQeryUrl",
    iconType: "başkent market",
    business: BaskentMarketQueryBusiness
});
