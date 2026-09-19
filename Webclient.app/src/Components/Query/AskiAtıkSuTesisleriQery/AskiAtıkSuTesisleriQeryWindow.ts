import { AskiAtıkSuTesisleriQeryBusiness } from '../../../Business/AskiAtıkSuTesisleriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Atık Su Tesisleri',
  serviceKey: 'YeniAskiAtıkSuTesisleriQeryUrl',
  iconType: 'atıksu tesisi',
  business: AskiAtıkSuTesisleriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiAtıkSuTesisleriQeryWindow = createManagedFastAccessQueryWindow(config);
