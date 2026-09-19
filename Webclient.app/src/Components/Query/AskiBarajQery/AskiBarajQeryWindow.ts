import { AskiBarajQeryBusiness } from '../../../Business/AskiBarajQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Barajları',
  serviceKey: 'YeniAskiBarajQeryUrl',
  iconType: 'baraj',
  business: AskiBarajQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiBarajQeryWindow = createManagedFastAccessQueryWindow(config);
