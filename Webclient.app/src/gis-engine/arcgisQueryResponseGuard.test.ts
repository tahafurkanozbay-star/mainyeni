import { describe, expect, it } from 'vitest';
import {
  ArcGisQueryResponseGuard,
  ArcGisResponseIntegrityError,
  arcGisResponseGuardConfigurationFromCapabilities,
  createArcGisQueryResponseGuard,
} from './arcgisQueryResponseGuard';
import type { ArcGisServiceCapabilities } from './arcgisCapabilityAdapter';

type Feature = {
  attributes: Record<string, unknown>;
  geometry?: unknown;
};

const feature = (
  id: number | string,
  overrides: Partial<Feature> = {},
): Feature => ({
  attributes: {
    OBJECTID: id,
    NAME: 'feature-' + String(id),
  },
  geometry: {
    x: 1,
    y: 2,
  },
  ...overrides,
});

const guard = (
  overrides: ConstructorParameters<typeof ArcGisQueryResponseGuard<Feature>>[0] = {},
): ArcGisQueryResponseGuard<Feature> => new ArcGisQueryResponseGuard<Feature>({
  objectIdField: 'OBJECTID',
  allowedFields: ['OBJECTID', 'NAME'],
  requireObjectId: true,
  maxFeaturesPerPage: 10,
  maxTotalFeatures: 100,
  ...overrides,
});

describe('ArcGisQueryResponseGuard page integrity', () => {
  it('accepts a bounded complete page and records deterministic progress', () => {
    const runtime = guard();
    const page = runtime.inspectPage({
      features: [feature(1), feature(2)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'page-0',
      offset: 0,
      expectedRecordCount: 10,
    });

    expect(page).toMatchObject({
      requestKey: 'page-0',
      page: 1,
      offset: 0,
      nextOffset: 2,
      rawFeatureCount: 2,
      acceptedFeatureCount: 2,
      duplicateFeatureCount: 0,
      exceededTransferLimit: false,
      complete: true,
      continuationRequired: false,
    });
    expect(runtime.snapshot()).toMatchObject({
      pages: 1,
      rawFeatures: 2,
      acceptedFeatures: 2,
      duplicateFeatures: 0,
      expectedOffset: 2,
      completed: true,
      seenObjectIds: 2,
      seenRequestKeys: 1,
    });
  });

  it('requires sequential pagination offsets', () => {
    const runtime = guard();
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(2)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'second',
      offset: 9,
    })).toThrowError(expect.objectContaining({
      code: 'PAGINATION_OFFSET_MISMATCH',
    }));
  });

  it('rejects reuse of request keys', () => {
    const runtime = guard();
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'same-key',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(2)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'same-key',
      offset: 1,
    })).toThrowError(expect.objectContaining({
      code: 'DUPLICATE_REQUEST_KEY',
    }));
  });

  it('does not allow pages after explicit completion', () => {
    const runtime = guard();
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'complete',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(2)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'late',
      offset: 1,
    })).toThrowError(expect.objectContaining({
      code: 'SEQUENCE_ALREADY_COMPLETE',
    }));
  });

  it('fails closed when transfer-limit evidence is missing', () => {
    const runtime = guard();
    const page = runtime.inspectPage({
      features: [feature(1)],
    }, {
      requestKey: 'unknown-transfer',
      offset: 0,
    });

    expect(page).toMatchObject({
      exceededTransferLimit: null,
      complete: false,
      continuationRequired: false,
    });
    expect(page.warnings).toContain('transfer-limit-evidence-missing');
  });

  it('rejects a transfer-limited empty page because pagination cannot advance', () => {
    const runtime = guard();
    expect(() => runtime.inspectPage({
      features: [],
      exceededTransferLimit: true,
    }, {
      requestKey: 'stalled',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'PAGINATION_NO_PROGRESS',
    }));
  });

  it('warns when a transfer-limited page is unexpectedly shorter than requested', () => {
    const runtime = guard();
    const page = runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'short-page',
      offset: 0,
      expectedRecordCount: 10,
    });

    expect(page.warnings).toContain('transfer-limit-short-page');
  });
});

describe('ArcGisQueryResponseGuard identity and fields', () => {
  it('drops duplicate object ids across page boundaries by default', () => {
    const runtime = guard();
    runtime.inspectPage({
      features: [feature(1), feature(2)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    const second = runtime.inspectPage({
      features: [feature(2), feature(3)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'second',
      offset: 2,
    });

    expect(second.features.map((item) => item.attributes.OBJECTID)).toEqual([3]);
    expect(second).toMatchObject({
      rawFeatureCount: 2,
      acceptedFeatureCount: 1,
      duplicateFeatureCount: 1,
    });
    expect(second.warnings).toContain('duplicate-object-id-dropped');
  });

  it('can reject duplicate object ids for strict feeds', () => {
    const runtime = guard({ duplicateObjectIdPolicy: 'reject' });
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'second',
      offset: 1,
    })).toThrowError(expect.objectContaining({
      code: 'DUPLICATE_OBJECT_ID',
    }));
  });

  it('keeps numeric and string identities distinct', () => {
    const runtime = guard();
    const page = runtime.inspectPage({
      features: [feature(1), feature('1')],
      exceededTransferLimit: false,
    }, {
      requestKey: 'typed-ids',
      offset: 0,
    });

    expect(page.acceptedFeatureCount).toBe(2);
    expect(runtime.snapshot().seenObjectIds).toBe(2);
  });

  it('rejects missing, unsafe, or unsupported object ids', () => {
    expect(() => guard().inspectPage({
      features: [{ attributes: { NAME: 'missing' } }],
      exceededTransferLimit: false,
    }, {
      requestKey: 'missing',
      offset: 0,
    })).toThrowError(expect.objectContaining({ code: 'OBJECT_ID_REQUIRED' }));

    expect(() => guard().inspectPage({
      features: [feature(Number.MAX_SAFE_INTEGER + 2)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'unsafe',
      offset: 0,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_OBJECT_ID' }));

    expect(() => guard().inspectPage({
      features: [feature(1, {
        attributes: { OBJECTID: { nested: true }, NAME: 'invalid' },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'object-id-object',
      offset: 0,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_OBJECT_ID' }));
  });

  it('warns about unknown fields when metadata enforcement is advisory', () => {
    const runtime = guard();
    const page = runtime.inspectPage({
      features: [feature(1, {
        attributes: {
          OBJECTID: 1,
          NAME: 'one',
          EXTRA: 'unverified',
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'unknown-field',
      offset: 0,
    });

    expect(page.warnings).toContain('unknown-field-observed');
  });

  it('rejects unknown fields when strict metadata enforcement is enabled', () => {
    const runtime = guard({ rejectUnknownFields: true });

    expect(() => runtime.inspectPage({
      features: [feature(1, {
        attributes: {
          OBJECTID: 1,
          NAME: 'one',
          EXTRA: 'unverified',
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'strict-field',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'UNKNOWN_FIELD',
    }));
  });
});

describe('ArcGisQueryResponseGuard resource budgets', () => {
  it('rejects page feature cardinality overflow', () => {
    const runtime = guard({ maxFeaturesPerPage: 2, maxTotalFeatures: 10 });
    expect(() => runtime.inspectPage({
      features: [feature(1), feature(2), feature(3)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'too-many',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'PAGE_FEATURE_BUDGET_EXCEEDED',
    }));
  });

  it('rejects total feature cardinality overflow across pages', () => {
    const runtime = guard({ maxFeaturesPerPage: 2, maxTotalFeatures: 3 });
    runtime.inspectPage({
      features: [feature(1), feature(2)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(3), feature(4)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'second',
      offset: 2,
    })).toThrowError(expect.objectContaining({
      code: 'TOTAL_FEATURE_BUDGET_EXCEEDED',
    }));
  });

  it('rejects page-count overflow', () => {
    const runtime = guard({
      maxPages: 1,
      maxFeaturesPerPage: 2,
      maxTotalFeatures: 10,
    });
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: true,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(2)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'second',
      offset: 1,
    })).toThrowError(expect.objectContaining({
      code: 'PAGE_BUDGET_EXCEEDED',
    }));
  });

  it('rejects attribute cardinality overflow', () => {
    const runtime = guard({ maxAttributesPerFeature: 2 });
    expect(() => runtime.inspectPage({
      features: [feature(1, {
        attributes: {
          OBJECTID: 1,
          NAME: 'one',
          EXTRA: true,
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'attributes',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'ATTRIBUTE_BUDGET_EXCEEDED',
    }));
  });

  it('rejects giant strings before they can enter cache or render state', () => {
    const runtime = guard({ maxStringValueLength: 8 });
    expect(() => runtime.inspectPage({
      features: [feature(1, {
        attributes: {
          OBJECTID: 1,
          NAME: '0123456789',
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'string',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'STRING_BUDGET_EXCEEDED',
    }));
  });

  it('rejects deeply nested response values', () => {
    const runtime = guard({ maxTraversalDepth: 2 });
    expect(() => runtime.inspectPage({
      features: [feature(1, {
        geometry: { a: { b: { c: 1 } } },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'deep',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'TRAVERSAL_DEPTH_EXCEEDED',
    }));
  });

  it('rejects oversized geometry numeric payloads', () => {
    const runtime = guard({ maxGeometryNumericValues: 3 });
    expect(() => runtime.inspectPage({
      features: [feature(1, {
        geometry: {
          paths: [[0, 0], [1, 1]],
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'geometry',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'GEOMETRY_COORDINATE_BUDGET_EXCEEDED',
    }));
  });

  it('rejects cyclic object graphs', () => {
    const geometry: Record<string, unknown> = {};
    geometry.self = geometry;
    const runtime = guard();

    expect(() => runtime.inspectPage({
      features: [feature(1, { geometry })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'cycle',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'CYCLIC_RESPONSE_VALUE',
    }));
  });

  it('rejects unsupported runtime values', () => {
    const runtime = guard();
    expect(() => runtime.inspectPage({
      features: [feature(1, {
        attributes: {
          OBJECTID: 1,
          NAME: Symbol('unsupported'),
        },
      })],
      exceededTransferLimit: false,
    }, {
      requestKey: 'symbol',
      offset: 0,
    })).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_VALUE',
    }));
  });
});

describe('ArcGisQueryResponseGuard configuration and reset', () => {
  it('derives verified field and object-id defaults from ArcGIS capabilities', () => {
    const capabilities: ArcGisServiceCapabilities = {
      kind: 'feature-server',
      geometryType: 'point',
      name: 'Stops',
      objectIdField: 'OBJECTID',
      globalIdField: null,
      maxRecordCount: 2_000,
      spatialReferenceWkid: 3857,
      supportsQuery: true,
      supportsPagination: true,
      supportsOrderBy: true,
      supportsDistinct: true,
      supportsStatistics: true,
      supportsHavingClause: false,
      supportsSqlExpression: true,
      supportsReturningQueryExtent: true,
      supportsDistanceQuery: true,
      supportsCreate: false,
      supportsUpdate: false,
      supportsDelete: false,
      supportsSync: false,
      allowsGeometryUpdates: false,
      hasZ: false,
      hasM: false,
      hasTime: false,
      fieldNames: ['OBJECTID', 'NAME'],
      relationshipCount: 0,
      indexCount: 1,
      warnings: [],
    };

    expect(arcGisResponseGuardConfigurationFromCapabilities(capabilities)).toMatchObject({
      objectIdField: 'OBJECTID',
      allowedFields: ['OBJECTID', 'NAME'],
      requireObjectId: true,
      maxFeaturesPerPage: 2_000,
    });
  });

  it('requires an object-id field when requireObjectId is enabled', () => {
    expect(() => createArcGisQueryResponseGuard({
      requireObjectId: true,
      objectIdField: null,
    })).toThrow('requireObjectId requires objectIdField');
  });

  it('rejects inconsistent byte and feature budgets', () => {
    expect(() => createArcGisQueryResponseGuard({
      maxFeaturesPerPage: 10,
      maxTotalFeatures: 5,
    })).toThrow('maxTotalFeatures must be at least maxFeaturesPerPage');

    expect(() => createArcGisQueryResponseGuard({
      maxFeatureBytes: 2_000,
      maxEstimatedBytes: 1_000,
    })).toThrow('maxEstimatedBytes must be at least maxFeatureBytes');
  });

  it('resets all sequence evidence for a new independent query', () => {
    const runtime = guard();
    runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'first',
      offset: 0,
    });

    expect(runtime.reset()).toEqual({
      pages: 0,
      rawFeatures: 0,
      acceptedFeatures: 0,
      duplicateFeatures: 0,
      estimatedBytes: 0,
      expectedOffset: null,
      completed: false,
      warnings: [],
      seenObjectIds: 0,
      seenRequestKeys: 0,
    });

    expect(() => runtime.inspectPage({
      features: [feature(1)],
      exceededTransferLimit: false,
    }, {
      requestKey: 'first',
      offset: 0,
    })).not.toThrow();
  });

  it('uses typed integrity errors with stable error codes', () => {
    const runtime = guard();
    try {
      runtime.inspectPage({ features: undefined }, {
        requestKey: 'missing-features',
        offset: 0,
      });
      throw new Error('expected integrity error');
    } catch (error) {
      expect(error).toBeInstanceOf(ArcGisResponseIntegrityError);
      expect((error as ArcGisResponseIntegrityError).code).toBe('FEATURES_ARRAY_MISSING');
    }
  });
});
