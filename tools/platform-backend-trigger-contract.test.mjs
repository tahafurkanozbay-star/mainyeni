import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const workflowPath = '.github/workflows/platform-backend-validation.yml';
const requiredPaths = [
  'Api.Admin/**',
  'Api.Core/**',
  'Api.User/**',
  'Business/**',
  'Toolbox/**',
  'tests/**',
  'Directory.Build.props',
  'Directory.Packages.props',
  'global.json',
  'CityWorks.NetCore.sln',
  workflowPath,
];

// Only inspect the trigger's own paths, never mentions in other events or jobs.
function triggerPaths(source, event) {
  let section = '';
  let trigger = '';
  let inPaths = false;
  const paths = [];
  for (const line of source.split(/\r?\n/)) {
    const rootKey = line.match(/^([a-zA-Z_-]+):(?:\s|$)/);
    if (rootKey) {
      section = rootKey[1];
      trigger = '';
      inPaths = false;
      continue;
    }
    if (section !== 'on') continue;
    const eventKey = line.match(/^  ([a-zA-Z_-]+):(?:\s|$)/);
    if (eventKey) {
      trigger = eventKey[1];
      inPaths = false;
      continue;
    }
    if (trigger !== event) continue;
    const property = line.match(/^    ([a-zA-Z_-]+):(?:\s|$)/);
    if (property) {
      inPaths = property[1] === 'paths';
      continue;
    }
    if (!inPaths) continue;
    const item = line.match(/^      - ['"]([^'"]+)['"]\s*(?:#.*)?$/);
    if (item) paths.push(item[1]);
  }
  return paths;
}

const source = fs.readFileSync(path.join(root, workflowPath), 'utf8');
for (const event of ['pull_request', 'push']) {
  test(`backend validation includes central NuGet inputs for ${event}`, () => {
    const paths = triggerPaths(source, event);
    const included = new Set(paths);
    assert.deepEqual(requiredPaths.filter((required) => !included.has(required)), []);
    assert.equal(included.size, paths.length, 'duplicate trigger path');
  });
}

test('a path in a different event cannot satisfy a trigger contract', () => {
  const fixture = `on:
  pull_request:
    paths:
      - 'Directory.Packages.props'
  push:
    paths:
      - 'Api.Core/**'
jobs:
  test:
    runs-on: ubuntu-latest
`;
  assert.equal(triggerPaths(fixture, 'push').includes('Directory.Packages.props'), false);
});

test('a path in a job cannot satisfy a trigger contract', () => {
  const fixture = `on:
  pull_request:
    paths:
      - 'Api.Core/**'
jobs:
  Directory.Packages.props:
    runs-on: ubuntu-latest
`;
  assert.equal(triggerPaths(fixture, 'pull_request').includes('Directory.Packages.props'), false);
});
