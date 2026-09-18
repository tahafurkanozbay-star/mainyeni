import { KutuphanelerQueryBusiness } from '../../../Business/KutuphanelerQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Kütüphaneler',
  serviceKey: 'YeniKutuphanelerQueryUrl',
  iconType: 'kütüphane',
  business: KutuphanelerQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const KutuphanelerQueryWindow = createManagedFastAccessQueryWindow(config);
