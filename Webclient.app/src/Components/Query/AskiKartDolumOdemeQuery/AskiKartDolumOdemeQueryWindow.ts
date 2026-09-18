import { AskiKartDolumOdemeQueryBusiness } from '../../../Business/AskiKartDolumOdemeQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'ASKİ Kart Dolum ve Ödeme',
  serviceKey: 'YeniAskiKartDolumOdemeQueryUrl',
  iconType: 'kart dolum',
  business: AskiKartDolumOdemeQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const AskiKartDolumOdemeQueryWindow = createManagedFastAccessQueryWindow(config);
