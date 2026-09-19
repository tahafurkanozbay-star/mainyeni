import { AskiBolgeMudurlukleriQeryBusiness } from '../../../Business/AskiBolgeMudurlukleriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Bölge Müdürlükleri',
  serviceKey: 'YeniAskiBolgeMudurlukleriQeryUrl',
  iconType: 'bölge müdürlüğü',
  business: AskiBolgeMudurlukleriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiBolgeMudurlukleriQeryWindow = createManagedFastAccessQueryWindow(config);
