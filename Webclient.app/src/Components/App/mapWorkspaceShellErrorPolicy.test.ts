import { describe, expect, it } from 'vitest';
import {
  deriveMapWorkspaceRetryPresentation,
  mapWorkspaceRetryMessage,
  sanitizeMapWorkspaceShellError,
} from './mapWorkspaceShellErrorPolicy';

describe('mapWorkspaceShellErrorPolicy', () => {
  it('returns an empty safe result for undefined input', () => {
    expect(sanitizeMapWorkspaceShellError(undefined)).toEqual({
      message: null,
      redacted: false,
      truncated: false,
    });
  });

  it('returns an empty safe result for null input', () => {
    expect(sanitizeMapWorkspaceShellError(null)).toEqual({
      message: null,
      redacted: false,
      truncated: false,
    });
  });

  it('returns an empty safe result for whitespace input', () => {
    expect(sanitizeMapWorkspaceShellError(' \n\t ')).toEqual({
      message: null,
      redacted: false,
      truncated: false,
    });
  });

  it('keeps ordinary user-safe text unchanged', () => {
    expect(sanitizeMapWorkspaceShellError('Harita başlatılamadı.')).toEqual({
      message: 'Harita başlatılamadı.',
      redacted: false,
      truncated: false,
    });
  });

  it('collapses repeated whitespace', () => {
    expect(sanitizeMapWorkspaceShellError('Harita   şu anda\n hazır değil.').message)
      .toBe('Harita şu anda hazır değil.');
  });

  it('removes control characters without exposing raw codes', () => {
    const safe = sanitizeMapWorkspaceShellError('Harita\u0000\u0007 başarısız\u007f oldu');
    expect(safe.message).toBe('Harita başarısız oldu');
    expect([...(safe.message ?? '')].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })).toBe(false);
  });

  it('redacts http URLs', () => {
    const safe = sanitizeMapWorkspaceShellError('Servis https://internal.example.local/api/map yanıt vermedi');
    expect(safe.message).toBe('Servis [ayrıntı gizlendi] yanıt vermedi');
    expect(safe.redacted).toBe(true);
  });

  it('redacts https URLs with query strings', () => {
    const safe = sanitizeMapWorkspaceShellError('Hata: https://example.test/path?token=secret&x=1');
    expect(safe.message).toBe('Hata: [ayrıntı gizlendi]');
    expect(safe.message).not.toContain('token=secret');
  });

  it('redacts Windows filesystem paths', () => {
    const safe = sanitizeMapWorkspaceShellError('Dosya C:\\workspace\\kent\\config.json okunamadı');
    expect(safe.message).toContain('[ayrıntı gizlendi]');
    expect(safe.message).not.toContain('workspace');
    expect(safe.redacted).toBe(true);
  });

  it('redacts Unix filesystem paths', () => {
    const safe = sanitizeMapWorkspaceShellError('Dosya /srv/kent/config.json okunamadı');
    expect(safe.message).toContain('[ayrıntı gizlendi]');
    expect(safe.message).not.toContain('/srv/kent');
    expect(safe.redacted).toBe(true);
  });

  it('can redact multiple sensitive locations in one message', () => {
    const safe = sanitizeMapWorkspaceShellError(
      'https://one.test/a ve https://two.test/b yolları /srv/maps/private.json ile eşleşmedi',
    );
    expect(safe.message?.match(/\[ayrıntı gizlendi\]/gu)).toHaveLength(3);
    expect(safe.redacted).toBe(true);
  });

  it('truncates oversized text at the default boundary', () => {
    const safe = sanitizeMapWorkspaceShellError('x'.repeat(500));
    expect(safe.message).toHaveLength(180);
    expect(safe.truncated).toBe(true);
  });

  it('marks short text as not truncated', () => {
    const safe = sanitizeMapWorkspaceShellError('Kısa hata');
    expect(safe.truncated).toBe(false);
  });

  it('supports a caller-provided maximum length', () => {
    const safe = sanitizeMapWorkspaceShellError('x'.repeat(200), 96);
    expect(safe.message).toHaveLength(96);
    expect(safe.truncated).toBe(true);
  });

  it('clamps an unsafe low maximum length', () => {
    const safe = sanitizeMapWorkspaceShellError('x'.repeat(200), 1);
    expect(safe.message).toHaveLength(48);
  });

  it('clamps an excessive maximum length', () => {
    const safe = sanitizeMapWorkspaceShellError('x'.repeat(500), 10_000);
    expect(safe.message).toHaveLength(320);
  });

  it('uses the default maximum for non-finite values', () => {
    const safe = sanitizeMapWorkspaceShellError('x'.repeat(500), Number.NaN);
    expect(safe.message).toHaveLength(180);
  });

  it('returns frozen safe results', () => {
    expect(Object.isFrozen(sanitizeMapWorkspaceShellError('Hata'))).toBe(true);
  });

  it('does not falsely mark whitespace normalization as redaction', () => {
    const safe = sanitizeMapWorkspaceShellError('Harita   başarısız');
    expect(safe.redacted).toBe(false);
  });

  it('derives an actionable retry presentation when retry is allowed and wired', () => {
    expect(deriveMapWorkspaceRetryPresentation(true, true)).toBe('action');
  });

  it('derives unavailable retry when the shell has no retry callback', () => {
    expect(deriveMapWorkspaceRetryPresentation(true, false)).toBe('unavailable');
  });

  it('derives exhausted retry after the retry budget is consumed', () => {
    expect(deriveMapWorkspaceRetryPresentation(false, true)).toBe('exhausted');
    expect(deriveMapWorkspaceRetryPresentation(false, false)).toBe('exhausted');
  });

  it('describes unavailable retry without claiming that the budget is exhausted', () => {
    const message = mapWorkspaceRetryMessage('unavailable');
    expect(message).toContain('yeniden başlatma eylemi kullanılamıyor');
    expect(message).not.toContain('güvenlik sınırına ulaşıldı');
  });

  it('describes exhausted retry as a bounded safety state', () => {
    const message = mapWorkspaceRetryMessage('exhausted');
    expect(message).toContain('güvenlik sınırına ulaşıldı');
    expect(message).toContain('Bağlantınızı kontrol');
  });

  it('never places URLs in retry guidance', () => {
    expect(mapWorkspaceRetryMessage('unavailable')).not.toMatch(/https?:\/\//iu);
    expect(mapWorkspaceRetryMessage('exhausted')).not.toMatch(/https?:\/\//iu);
  });

  it('never places telemetry or network implementation language in retry guidance', () => {
    const combined = `${mapWorkspaceRetryMessage('unavailable')} ${mapWorkspaceRetryMessage('exhausted')}`.toLowerCase();
    expect(combined).not.toContain('telemetry');
    expect(combined).not.toContain('fetch');
    expect(combined).not.toContain('endpoint');
  });
});
