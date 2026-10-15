import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const controller = readFileSync(
  new URL('../../Api.Admin/Controllers/Core/SystemController.cs', import.meta.url),
  'utf8',
);
const filter = readFileSync(
  new URL('../../Api.Admin/Filters/AdminRequestFilterAttribute.cs', import.meta.url),
  'utf8',
);

test('admin database status endpoint requires the registered authentication filter', () => {
  assert.match(controller, /\[ServiceFilter\(typeof\(AdminRequestFilterAttribute\)\)\]\s*\[Route\("\[controller\]\/Check"\)\]/u);
  assert.match(filter, /StatusCodes\.Status401Unauthorized/u);
});

test('admin database status preserves DI-owned pooled context lifecycle', () => {
  assert.doesNotMatch(controller, /using\s*\(\s*dbContext\s*\)/u);
  assert.doesNotMatch(controller, /dbContext\.Dispose\s*\(/u);
  assert.match(controller, /await\s+dbContext\.Database\.CanConnectAsync\(cancellationToken\)/u);
});

test('cancellation is preserved rather than converted to a database failure', () => {
  assert.match(controller, /catch\s*\(OperationCanceledException\)\s*when\s*\(cancellationToken\.IsCancellationRequested\)/u);
  assert.match(controller, /throw\s*;/u);
});
