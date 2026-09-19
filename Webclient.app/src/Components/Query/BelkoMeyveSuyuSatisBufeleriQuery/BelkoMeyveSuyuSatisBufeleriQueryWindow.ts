import { BelkoMeyveSuyuSatisBufeleriQueryBusiness } from '../../../Business/BelkoMeyveSuyuSatisBufeleriQueryBusiness';
import {
  createManagedFastAccessQueryWindow,
  type ManagedFastAccessQueryWindowOptions,
} from '../_Common/ManagedFastAccessQueryWindow';

const config = {
  title: 'BELKO Meyve Suyu Satış Büfeleri',
  serviceKey: 'YeniBelkoMeyveSuyuSatisBufeleriQueryUrl',
  iconType: 'belko meyve suyu',
  business: BelkoMeyveSuyuSatisBufeleriQueryBusiness,
} satisfies ManagedFastAccessQueryWindowOptions;

export const BelkoMeyveSuyuSatisBufeleriQueryWindow = createManagedFastAccessQueryWindow(config);
