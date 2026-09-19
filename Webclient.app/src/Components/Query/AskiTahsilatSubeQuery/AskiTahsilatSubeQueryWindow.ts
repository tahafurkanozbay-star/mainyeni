import { AskiTahsilatSubeQueryBusiness } from '../../../Business/AskiTahsilatSubeQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Tahsilat Şubeleri',
  serviceKey: 'YeniAskiTahsilatSubeQueryUrl',
  iconType: 'tahsilat şubesi',
  business: AskiTahsilatSubeQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiTahsilatSubeQueryWindow = createManagedFastAccessQueryWindow(config);
