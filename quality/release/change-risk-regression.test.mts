import assert from 'node:assert/strict';
import test from 'node:test';
import { countLines } from './inventory.mts';
import {
  classifyRiskAreas,
  evidenceSupportsArea,
  isTestPath,
  testSupportsArea,
} from './change-risk-policy.mts';

// These regressions pin the semantics that previously failed only in the
// typed-release lane. They deliberately exercise public policy primitives
// rather than reproducing the implementation under test.

test('canonical line accounting includes the terminal empty line', () => {
  assert.equal(countLines('export const value = 1;\n'), 2);
  assert.equal(countLines('a\nb\n'), 3);
  assert.equal(countLines(''), 0);
});

test('line accounting remains stable without a terminal newline', () => {
  assert.equal(countLines('export const value = 1;'), 1);
  assert.equal(countLines('a\nb'), 2);
});

test('PascalCase repository compounds retain data ownership', () => {
  const areas = classifyRiskAreas('Api.Core/Data/ParcelRepository.cs', 'public sealed class ParcelRepository {}');
  assert.equal(areas.includes('data'), true);
});

test('PascalCase model compounds retain data ownership', () => {
  const areas = classifyRiskAreas('Api.Core/Domain/ParcelSchema.cs', 'public sealed class ParcelSchema {}');
  assert.equal(areas.includes('data'), true);
});

test('camelCase viewport compounds retain responsive ownership', () => {
  const areas = classifyRiskAreas('Webclient.app/src/platform/viewportPolicy.ts', 'export const viewportPolicy = true;');
  assert.equal(areas.includes('responsive'), true);
});

test('camelCase layout compounds retain responsive ownership', () => {
  const areas = classifyRiskAreas('Webclient.app/src/platform/mobileLayout.ts', 'export const mobileLayout = true;');
  assert.equal(areas.includes('responsive'), true);
});

test('database repository path can carry both database and data ownership', () => {
  const areas = classifyRiskAreas('database/migrations/ParcelRepository.sql', 'ALTER TABLE parcel ADD name text;');
  assert.equal(areas.includes('database'), true);
  assert.equal(areas.includes('data'), true);
});

test('GIS test paths are recognized as tests and GIS evidence', () => {
  const path = 'Webclient.app/src/gis/LayerBudget.test.ts';
  assert.equal(isTestPath(path), true);
  assert.equal(testSupportsArea(path, 'gis'), true);
  assert.equal(evidenceSupportsArea(path, 'gis'), true);
});

test('renamed GIS test paths preserve focused ownership', () => {
  const before = 'Webclient.app/src/gis/OldLayer.test.ts';
  const after = 'Webclient.app/src/gis/NewLayer.test.ts';
  assert.equal(testSupportsArea(before, 'gis'), true);
  assert.equal(testSupportsArea(after, 'gis'), true);
});

test('unrelated component tests cannot impersonate GIS evidence', () => {
  const path = 'Webclient.app/src/components/Card.test.tsx';
  assert.equal(isTestPath(path), true);
  assert.equal(testSupportsArea(path, 'gis'), false);
  assert.equal(evidenceSupportsArea(path, 'gis'), false);
});

test('responsive tests own responsive evidence independently of production classification', () => {
  const path = 'Webclient.app/src/platform/viewportPolicy.test.ts';
  assert.equal(testSupportsArea(path, 'responsive'), true);
  assert.equal(evidenceSupportsArea(path, 'responsive'), true);
});

test('data repository tests own data evidence independently of production classification', () => {
  const path = 'Webclient.app/src/data/ParcelRepository.test.ts';
  assert.equal(testSupportsArea(path, 'data'), true);
  assert.equal(evidenceSupportsArea(path, 'data'), true);
});
