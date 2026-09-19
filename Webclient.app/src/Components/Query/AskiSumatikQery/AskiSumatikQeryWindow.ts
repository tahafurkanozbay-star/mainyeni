import { AskiSumatikQueryBusiness } from '../../../Business/AskiSumatikQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Sumatik',
  serviceKey: 'YeniAskiSumatikQueryUrl',
  iconType: 'sumatik',
  business: AskiSumatikQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiSumatikQeryWindow = createManagedFastAccessQueryWindow(config);
