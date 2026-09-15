import { PatiDostuQueryBusiness } from "../../../Business/PatiDostuQueryBusiness";
import { createManagedFastAccessQueryWindow } from "../_Common/ManagedFastAccessQueryWindow";

export const PatiDostuQueryWindow = createManagedFastAccessQueryWindow({
    title: "Pati Dostu Uygulamalar",
    serviceKey: "YeniPatiDostuQeryUrl",
    iconType: "pati dostu",
    business: PatiDostuQueryBusiness
});
