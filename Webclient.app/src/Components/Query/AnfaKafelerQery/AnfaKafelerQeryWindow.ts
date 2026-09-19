import { AnfaKafelerQeryBusiness } from '../../../Business/AnfaKafelerQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ANFA Kafeler',
  serviceKey: 'YeniAnfaKafelerQeryUrl',
  iconType: 'anfa kafe',
  business: AnfaKafelerQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AnfaKafelerQeryWindow = createManagedFastAccessQueryWindow(config);
