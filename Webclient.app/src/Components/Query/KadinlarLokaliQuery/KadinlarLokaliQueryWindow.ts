import { KadinLokaliQueryBusiness } from '../../../Business/KadinLokaliQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Kadınlar Lokali',
  serviceKey: 'YeniKadinlarLokaliQeryUrl',
  iconType: 'kadınlar lokali',
  business: KadinLokaliQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const KadinlarLokaliQueryWindow = createManagedFastAccessQueryWindow(config);
