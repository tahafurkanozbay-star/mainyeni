import { PatiDostuQueryBusiness } from '../../../Business/PatiDostuQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Pati Dostu Uygulamalar',
  serviceKey: 'YeniPatiDostuQeryUrl',
  iconType: 'pati dostu',
  business: PatiDostuQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const PatiDostuQueryWindow = createManagedFastAccessQueryWindow(config);
