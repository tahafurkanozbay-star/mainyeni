import { AnfaOtoparkQeryBusiness } from '../../../Business/AnfaOtoparkQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ANFA Otopark',
  serviceKey: 'YeniAnfaOtoparkQeryUrl',
  iconType: 'anfa otopark',
  business: AnfaOtoparkQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AnfaOtoparkQueryWindow = createManagedFastAccessQueryWindow(config);
