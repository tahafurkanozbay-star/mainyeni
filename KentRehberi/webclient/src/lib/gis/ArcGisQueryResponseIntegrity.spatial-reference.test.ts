import { describe, expect, it } from 'vitest'
import { ArcGisQueryResponseIntegrity } from './ArcGisQueryResponseIntegrity'

const inspector = new ArcGisQueryResponseIntegrity()
const context = { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 4326 }

function feature(wkid: unknown) {
  return {
    attributes: { OBJECTID: 7 },
    geometry: { x: 29, y: 41, spatialReference: { wkid } },
  }
}

describe('ArcGIS feature-level spatial-reference integrity', () => {
  it('accepts a feature geometry with the expected spatial reference', () => {
    expect(inspector.inspect({
      features: [feature(4326)], spatialReference: { wkid: 4326 },
    }, context).kind).toBe('accepted')
  })

  it('rejects feature SR that disagrees with response SR', () => {
    expect(inspector.inspect({
      features: [feature(3857)], spatialReference: { wkid: 4326 },
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'spatial-reference-mismatch', featureIndex: 0 },
    })
  })

  it('rejects feature SR that disagrees with the requested output SR when response SR is omitted', () => {
    expect(inspector.inspect({ features: [feature(3857)] }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'spatial-reference-mismatch', featureIndex: 0 },
    })
  })

  it.each([0, -1, Number.NaN, '4326'])('rejects malformed geometry wkid %p', wkid => {
    expect(inspector.inspect({ features: [feature(wkid)] }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference', featureIndex: 0 },
    })
  })

  it('rejects primitive geometry spatial-reference declarations', () => {
    expect(inspector.inspect({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { x: 1, y: 2, spatialReference: 'EPSG:4326' } }],
    }, context)).toMatchObject({
      kind: 'rejected', issue: { code: 'invalid-spatial-reference', featureIndex: 0 },
    })
  })

  it('accepts canonical latestWkid aliases on individual geometries', () => {
    expect(inspector.inspect({
      features: [{
        attributes: { OBJECTID: 7 },
        geometry: { x: 1, y: 2, spatialReference: { wkid: 102100, latestWkid: 3857 } },
      }],
      spatialReference: { wkid: 102100, latestWkid: 3857 },
    }, { objectIdField: 'OBJECTID', expectedSpatialReferenceWkid: 3857 }).kind).toBe('accepted')
  })

  it('does not reject features that omit geometry spatial references', () => {
    expect(inspector.inspect({
      features: [{ attributes: { OBJECTID: 7 }, geometry: { x: 1, y: 2 } }],
      spatialReference: { wkid: 4326 },
    }, context).kind).toBe('accepted')
  })
})
