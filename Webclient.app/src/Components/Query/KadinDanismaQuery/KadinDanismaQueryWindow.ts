import { KadinDanismaQueryBusiness } from '../../../Business/KadinDanismaQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Kadın Danışma Merkezi',
  serviceKey: 'YeniKadinDanismaQueryUrl',
  iconType: 'kadın danışma merkezi',
  business: KadinDanismaQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const KadinDanismaQueryWindow = createManagedFastAccessQueryWindow(config);
