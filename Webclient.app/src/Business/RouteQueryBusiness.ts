import type { FastAccessQuery } from './contracts';
import {
  businessQueryPlanner,
  businessQueryRuntime,
  normalizeRouteQuery,
  compileRequiredPredicatePlan,
  equalsPredicate,
  numericEqualsPredicate,
  routeTypePredicate,
  upperContainsPredicate,
} from './runtime';

const SERVICE_KEY = 'RouteQueryUrl';

export interface RouteQueryInput extends FastAccessQuery {
  readonly Id?: string | number | null;
  readonly showCultureWalkingRoute?: boolean;
  readonly showNatureWalkingRoute?: boolean;
  readonly routeLevel?: string | number | null;
}

const routeWhere = (input: RouteQueryInput | null | undefined): string => {
  const query = normalizeRouteQuery(input);
  const objectIdNumber = query.objectId === null ? null : Number(query.objectId);
  const predicates: Array<string | null> = [
    '(tip=1 or tip=2)',
    upperContainsPredicate('adi', query.name),
    equalsPredicate('ilceid', query.districtId),
    ...routeTypePredicate(
      query.showCultureWalkingRoute,
      query.showNatureWalkingRoute,
      query.objectId !== null,
    ),
    numericEqualsPredicate('zorlukderecesi', query.routeLevel),
    query.objectId !== null && Number.isFinite(objectIdNumber)
      ? numericEqualsPredicate('objectid', objectIdNumber)
      : null,
  ];

  return compileRequiredPredicatePlan(predicates).where;
};

export const RouteQueryBusiness = Object.freeze({
  Query: async (
    input: RouteQueryInput = {},
    returnGeometry = false,
  ): Promise<unknown> => {
    const query = normalizeRouteQuery(input);
    const where = routeWhere(input);

    const plan = businessQueryPlanner.plan({
      serviceKey: SERVICE_KEY,
      returnGeometry: Boolean(returnGeometry),
      orderByFields: ['adi'],
      outFields: ['*'],
      where: query.showNearby ? '(tip=1 or tip=2)' : where,
      ...(query.showNearby
        ? {
          spatial: {
            geometry: query.userLocation,
            distance: query.bufferDistance,
            units: 'meters',
            spatialRelationship: 'intersects',
          } as const,
        }
        : {}),
    });

    return businessQueryRuntime.execute(plan);
  },
});
