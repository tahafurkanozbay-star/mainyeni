import { BaskentMarketQueryBusiness } from '../../../Business/BaskentMarketQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'Başkent Market',
  serviceKey: 'YeniBaskentMarketQeryUrl',
  iconType: 'başkent market',
  business: BaskentMarketQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const BaskentMarketQueryWindow = createManagedFastAccessQueryWindow(config);
