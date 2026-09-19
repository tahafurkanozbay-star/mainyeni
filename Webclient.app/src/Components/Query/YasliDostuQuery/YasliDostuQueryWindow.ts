import { YasliDostuQueryBusiness } from '../../../Business/YasliDostuQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Yaşlı Dostu Uygulamalar',
  serviceKey: 'YeniYasliDostuQueryUrl',
  iconType: 'yaşlı dostu uygulama',
  business: YasliDostuQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const YasliDostuQueryWindow = createManagedFastAccessQueryWindow(config);
