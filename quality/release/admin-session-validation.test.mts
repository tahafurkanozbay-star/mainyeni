import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSafeBearerToken,
  isValidAdminSession,
} from '../../Webclient.admin/src/Business/AdminSessionValidation.ts';

test('valid JWT and opaque bearer tokens retain compatibility', () => {
  for (const token of [
    'a.b.c',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'opaque-token_~+/==',
    'x',
  ]) {
    assert.equal(isSafeBearerToken(token), true, token);
    assert.equal(isValidAdminSession({ accessToken: token }), true, token);
  }
});

test('rejects newline/header injection, leading spaces and malformed bearer values', () => {
  for (const token of [
    '', ' ', 'Bearer abc', 'abc\r\nX-Leak: value', 'abc\n',
    'token,another', 'token\tvalue', 'token%0A', '💡',
    'a'.repeat(8_193),
  ]) {
    assert.equal(isSafeBearerToken(token), false, JSON.stringify(token));
    assert.equal(isValidAdminSession({ accessToken: token }), false, JSON.stringify(token));
  }
});

test('rejects arrays, null, inherited tokens and invalid session metadata', () => {
  for (const candidate of [
    null, undefined, [], 'abc', 42,
    { accessToken: 1 },
    { accessToken: 'abc', userName: 12 },
    { accessToken: 'abc', userName: 'x'.repeat(513) },
    Object.create({ accessToken: 'abc' }) as unknown,
  ]) {
    assert.equal(isValidAdminSession(candidate), false);
  }
});

test('accepts bounded optional user metadata without mutating the session', () => {
  const session = Object.freeze({ accessToken: 'a.b.c', userName: 'Admin', department: 'GIS' });
  assert.equal(isValidAdminSession(session), true);
  assert.equal(session.department, 'GIS');
  assert.equal(isValidAdminSession({ accessToken: 'abc', userName: '' }), true);
  assert.equal(isValidAdminSession({ accessToken: 'abc', userName: 'x'.repeat(512) }), true);
});
