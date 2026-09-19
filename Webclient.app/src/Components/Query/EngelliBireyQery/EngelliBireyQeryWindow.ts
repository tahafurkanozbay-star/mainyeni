import { EngelliBireyQeryBusiness } from '../../../Business/EngelliBireyQeryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Engelli Birey Hizmetleri',
  serviceKey: 'YeniEngelliBireyQeryUrl',
  iconType: 'engelsiz yaşam',
  business: EngelliBireyQeryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EngelliBireyQeryWindow = createManagedFastAccessQueryWindow(config);
