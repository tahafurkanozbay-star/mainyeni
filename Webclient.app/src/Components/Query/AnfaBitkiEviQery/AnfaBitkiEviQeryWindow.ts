import { AnfaBitkiEviQeryBusiness } from '../../../Business/AnfaBitkiEviQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ANFA Bitki Evi',
  serviceKey: 'YeniAnfaBitkiEviQeryUrl',
  iconType: 'anfa bitki evi',
  business: AnfaBitkiEviQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AnfaBitkiEviQeryWindow = createManagedFastAccessQueryWindow(config);
