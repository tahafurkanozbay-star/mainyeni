import { EngelliCocukQueryBusiness } from '../../../Business/EngelliCocukQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Engelli Çocuk Hizmetleri',
  serviceKey: 'YeniEngelliCocukQueryUrl',
  iconType: 'engelsiz kreş',
  business: EngelliCocukQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const EngelliCocukQueryWindow = createManagedFastAccessQueryWindow(config);
