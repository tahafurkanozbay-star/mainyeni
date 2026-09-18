import { EgoOtobusDuraklariQueryBusiness } from '../../../Business/EgoOtobusDuraklariQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Otobüs Durakları',
  serviceKey: 'YeniEgoOtobusDuraklariQueryUrl',
  iconType: 'otobüs durağı',
  business: EgoOtobusDuraklariQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EgoOtobusDuraklariQueryWindow = createManagedFastAccessQueryWindow(config);
