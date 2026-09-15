import { GazilerMerkeziQeyBusiness } from "../../../Business/GazilerMerkeziQeyBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const GazilerMerkeziQueryWindow = createManagedFastAccessQueryWindow({
    title: "Gaziler Merkezi",
    serviceKey: "YeniGazilerMerkeziQeyUrl",
    iconType: "gazi merkezi",
    business: GazilerMerkeziQeyBusiness
});
