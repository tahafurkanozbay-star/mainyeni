export const RELEASE_PR_LIFECYCLE_VERSION = 1;

const freeze = value => Object.freeze(value);
const finding = (code, field, message) => freeze({ code, field, message, severity: 'error' });
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
};

export function evaluateReleasePrLifecycle(input, options = {}) {
  const findings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return freeze({ version: RELEASE_PR_LIFECYCLE_VERSION, passed: false, mergeAllowed: false, findings: freeze([finding('evidence-invalid', '$', 'PR lifecycle evidence must be an object.')]) });
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return freeze({ version: RELEASE_PR_LIFECYCLE_VERSION, passed: false, mergeAllowed: false, findings: freeze([finding('policy-invalid', 'options', 'PR lifecycle policy must be an object.')]), summary: freeze({ errors: 1 }) });
  }
  if (input.version !== RELEASE_PR_LIFECYCLE_VERSION) findings.push(finding('version-unsupported', 'version', `Version must be ${RELEASE_PR_LIFECYCLE_VERSION}.`));
  const number = Number.isSafeInteger(input.number) && input.number > 0 ? input.number : null;
  const state = input.state === 'open' || input.state === 'closed' ? input.state : null;
  const merged = typeof input.merged === 'boolean' ? input.merged : null;
  const draft = typeof input.draft === 'boolean' ? input.draft : null;
  const mergeable = typeof input.mergeable === 'boolean' ? input.mergeable : null;
  const baseSha = sha(input.baseSha);
  const headSha = sha(input.headSha);
  const createdAt = timestamp(input.createdAt);
  const updatedAt = timestamp(input.updatedAt);
  const observedAt = timestamp(input.observedAt);
  if (!number) findings.push(finding('number-invalid', 'number', 'PR number must be a positive safe integer.'));
  if (!state) findings.push(finding('state-invalid', 'state', 'PR state must be open or closed.'));
  if (merged === null) findings.push(finding('merged-invalid', 'merged', 'merged must be boolean.'));
  if (draft === null) findings.push(finding('draft-invalid', 'draft', 'draft must be boolean.'));
  if (mergeable === null) findings.push(finding('mergeable-invalid', 'mergeable', 'mergeable must be boolean.'));
  if (!baseSha) findings.push(finding('base-sha-invalid', 'baseSha', 'baseSha must be an exact SHA.'));
  if (!headSha) findings.push(finding('head-sha-invalid', 'headSha', 'headSha must be an exact SHA.'));
  if (createdAt === null) findings.push(finding('created-at-invalid', 'createdAt', 'createdAt must be canonical UTC ISO-8601.'));
  if (updatedAt === null) findings.push(finding('updated-at-invalid', 'updatedAt', 'updatedAt must be canonical UTC ISO-8601.'));
  if (observedAt === null) findings.push(finding('observed-at-invalid', 'observedAt', 'observedAt must be canonical UTC ISO-8601.'));
  if (state === 'closed') findings.push(finding('pr-closed', 'state', 'Release candidate PR must remain open.'));
  if (merged === true) findings.push(finding('pr-merged', 'merged', 'Release candidate PR must not already be merged.'));
  if (draft === true) findings.push(finding('pr-draft', 'draft', 'Release candidate PR must be ready for review.'));
  if (mergeable === false) findings.push(finding('pr-not-mergeable', 'mergeable', 'Release candidate PR must be mergeable.'));
  if (baseSha && headSha && baseSha === headSha) findings.push(finding('head-equals-base', 'headSha', 'Candidate head must differ from base.'));
  const expectedNumber = options.expectedNumber;
  if (expectedNumber !== undefined && (!Number.isSafeInteger(expectedNumber) || expectedNumber <= 0)) findings.push(finding('expected-number-invalid', 'options.expectedNumber', 'Expected PR number must be a positive safe integer.'));
  else if (expectedNumber !== undefined && number && number !== expectedNumber) findings.push(finding('number-mismatch', 'number', `Expected PR #${expectedNumber}; observed #${number}.`));
  const expectedHeadSha = options.expectedHeadSha === undefined ? null : sha(options.expectedHeadSha);
  if (options.expectedHeadSha !== undefined && !expectedHeadSha) findings.push(finding('expected-head-invalid', 'options.expectedHeadSha', 'Expected head must be an exact SHA.'));
  else if (expectedHeadSha && headSha && expectedHeadSha !== headSha) findings.push(finding('head-mismatch', 'headSha', 'Observed head does not equal expected exact head.'));
  const expectedBaseSha = options.expectedBaseSha === undefined ? null : sha(options.expectedBaseSha);
  if (options.expectedBaseSha !== undefined && !expectedBaseSha) findings.push(finding('expected-base-invalid', 'options.expectedBaseSha', 'Expected base must be an exact SHA.'));
  else if (expectedBaseSha && baseSha && expectedBaseSha !== baseSha) findings.push(finding('base-mismatch', 'baseSha', 'Observed base does not equal expected current main.'));
  const maxMetadataAgeMs = options.maxMetadataAgeMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(maxMetadataAgeMs) || maxMetadataAgeMs < 0 || maxMetadataAgeMs > 24 * 60 * 60 * 1000) findings.push(finding('freshness-policy-invalid', 'options.maxMetadataAgeMs', 'Metadata freshness budget must be between 0 and 24 hours.'));
  if (createdAt !== null && updatedAt !== null && updatedAt < createdAt) findings.push(finding('timestamp-order-invalid', 'updatedAt', 'updatedAt must not precede createdAt.'));
  if (updatedAt !== null && observedAt !== null && updatedAt > observedAt) findings.push(finding('metadata-from-future', 'updatedAt', 'updatedAt must not be later than observedAt.'));
  if (createdAt !== null && observedAt !== null && createdAt > observedAt) findings.push(finding('created-from-future', 'createdAt', 'createdAt must not be later than observedAt.'));
  if (updatedAt !== null && observedAt !== null && Number.isSafeInteger(maxMetadataAgeMs) && maxMetadataAgeMs >= 0 && observedAt - updatedAt > maxMetadataAgeMs) findings.push(finding('metadata-stale', 'updatedAt', 'PR metadata is older than the configured freshness budget.'));
  const ordered = freeze([...findings].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code)));
  return freeze({ version: RELEASE_PR_LIFECYCLE_VERSION, passed: ordered.length === 0, mergeAllowed: ordered.length === 0, findings: ordered, summary: freeze({ errors: ordered.length }) });
}
