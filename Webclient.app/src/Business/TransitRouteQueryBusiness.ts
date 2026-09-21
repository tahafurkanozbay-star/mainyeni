import { createMapQueryBusiness } from './createMapQueryBusiness';

export const TransitRouteQueryBusiness = createMapQueryBusiness({
  serviceKey: 'TransitRouteQueryUrl',
  searchField: 'id',
  orderByField: 'id',
});
