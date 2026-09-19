import { CocukEtkinlikMerkezleriQeryBusiness } from '../../../Business/CocukEtkinlikMerkezleriQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Çocuk Etkinlik Merkezleri',
  serviceKey: 'YeniCocukEtkinlikMerkezleriQeryUrl',
  iconType: 'çocuk etkinlik merkezi',
  business: CocukEtkinlikMerkezleriQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const CocukEtkinlikMerkezleriQeryWindow = createManagedFastAccessQueryWindow(config);
