import { describe, expect, it } from 'vitest';
import {
  createResultDetailExperienceModel,
  describeResultDetailChange,
  normalizeResultDetailSections,
  resolveResultDetailFocusTarget,
  resolveResultDetailKeyboard,
  resolveResultDetailPresentation,
  resolveResultDetailViewport,
  type ResultDetailInput,
} from './ArcGisResultDetailExperiencePolicy';

const base = (overrides: Partial<ResultDetailInput> = {}): ResultDetailInput => ({
  resultId: 'feature-42',
  title: 'Atatürk Parkı',
  viewportWidth: 1280,
  canClose: true,
  canZoom: true,
  canSelectOnMap: true,
  sections: [{
    id: 'general', label: 'Genel', expanded: true, fields: [
      { id: 'name', label: 'Ad', value: 'Atatürk Parkı', priority: 1, copyable: true },
      { id: 'area', label: 'Alan', value: 1250.5, kind: 'number', priority: 2 },
    ],
  }],
  ...overrides,
});

describe('ArcGisResultDetailExperiencePolicy', () => {
  it('maps viewport widths to deterministic responsive modes', () => {
    expect(resolveResultDetailViewport(320)).toBe('phone');
    expect(resolveResultDetailViewport(639)).toBe('phone');
    expect(resolveResultDetailViewport(640)).toBe('tablet');
    expect(resolveResultDetailViewport(1023)).toBe('tablet');
    expect(resolveResultDetailViewport(1024)).toBe('desktop');
    expect(resolveResultDetailViewport(Number.NaN)).toBe('desktop');
  });

  it('maps responsive modes to GIS-friendly presentations', () => {
    expect(resolveResultDetailPresentation('phone')).toBe('sheet');
    expect(resolveResultDetailPresentation('tablet')).toBe('drawer');
    expect(resolveResultDetailPresentation('desktop')).toBe('side-panel');
  });

  it('creates bounded accessible detail labels', () => {
    const model = createResultDetailExperienceModel(base());
    expect(model.dialogLabel).toBe('Atatürk Parkı ayrıntıları');
    expect(model.closeLabel).toBe('Ayrıntıyı kapat');
    expect(model.zoomLabel).toContain('konumuna yaklaş');
    expect(model.mapSelectionLabel).toContain('haritada seç');
    expect(model.statusAnnouncement).toContain('hazır');
  });

  it('uses a non-action close label when closing is unavailable', () => {
    expect(createResultDetailExperienceModel(base({ canClose: false })).closeLabel).toBe('Ayrıntı görünümü');
  });

  it('does not expose unavailable map actions', () => {
    const model = createResultDetailExperienceModel(base({ canZoom: false, canSelectOnMap: false }));
    expect(model.zoomLabel).toBeNull();
    expect(model.mapSelectionLabel).toBeNull();
  });

  it('normalizes duplicate sections and fields deterministically', () => {
    const sections = normalizeResultDetailSections([
      { id: 'a', label: 'A', fields: [{ id: 'x', label: 'X', value: 1 }, { id: 'x', label: 'Duplicate', value: 2 }] },
      { id: 'a', label: 'Duplicate section', fields: [] },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toHaveLength(1);
    expect(sections[0].fields[0].displayValue).toBe('1');
  });

  it('drops sections and fields without usable identity', () => {
    const sections = normalizeResultDetailSections([
      { id: ' ', label: 'Bad', fields: [] },
      { id: 'ok', label: ' ', fields: [] },
      { id: 'good', label: 'Good', fields: [{ id: ' ', label: 'Bad', value: 'x' }, { id: 'ok', label: ' ', value: 'x' }] },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0].fields).toHaveLength(0);
  });

  it('sorts fields by explicit priority then localized label', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [
      { id: 'z', label: 'Z', value: 1, priority: 20 },
      { id: 'b', label: 'B', value: 1, priority: 10 },
      { id: 'a', label: 'A', value: 1, priority: 10 },
    ] }]);
    expect(sections[0].fields.map((field) => field.id)).toEqual(['a', 'b', 'z']);
  });

  it('formats finite numbers with Turkish locale semantics', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [{ id: 'n', label: 'N', value: 1234.5, kind: 'number' }] }]);
    expect(sections[0].fields[0].displayValue).toMatch(/1[.]234,5/);
  });

  it('renders invalid numbers as empty presentation', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [{ id: 'n', label: 'N', value: 'not-number', kind: 'number' }] }]);
    expect(sections[0].fields[0]).toMatchObject({ displayValue: '—', empty: true });
  });

  it('formats booleans without leaking implementation values', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [
      { id: 'yes', label: 'Yes', value: true, kind: 'boolean' },
      { id: 'no', label: 'No', value: false, kind: 'boolean' },
    ] }]);
    expect(sections[0].fields.map((field) => field.displayValue)).toEqual(['Hayır', 'Evet']);
  });

  it('allows only http and https URL display values', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [
      { id: 'good', label: 'Good', value: 'https://example.test/a', kind: 'url' },
      { id: 'bad', label: 'Bad', value: 'javascript:alert(1)', kind: 'url' },
    ] }]);
    const values = Object.fromEntries(sections[0].fields.map((field) => [field.id, field.displayValue]));
    expect(values.good).toBe('https://example.test/a');
    expect(values.bad).toBe('—');
  });

  it('redacts sensitive field values and disables copying', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [{ id: 'secret', label: 'Secret', value: 'abc', sensitive: true, copyable: true }] }]);
    expect(sections[0].fields[0]).toMatchObject({ displayValue: 'Gizli bilgi', sensitive: true, copyable: false });
  });

  it('does not copy empty values', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [{ id: 'empty', label: 'Empty', value: null, copyable: true }] }]);
    expect(sections[0].fields[0]).toMatchObject({ empty: true, copyable: false });
  });

  it('bounds hostile field and section cardinality', () => {
    const sections = normalizeResultDetailSections(Array.from({ length: 40 }, (_, sectionIndex) => ({
      id: `s${sectionIndex}`, label: `S ${sectionIndex}`, fields: Array.from({ length: 100 }, (_, fieldIndex) => ({ id: `f${fieldIndex}`, label: `F ${fieldIndex}`, value: fieldIndex })),
    })));
    expect(sections).toHaveLength(16);
    expect(sections.every((section) => section.fields.length === 64)).toBe(true);
  });

  it('freezes normalized collections to discourage mutation', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', fields: [{ id: 'f', label: 'F', value: 1 }] }]);
    expect(Object.isFrozen(sections)).toBe(true);
    expect(Object.isFrozen(sections[0])).toBe(true);
    expect(Object.isFrozen(sections[0].fields)).toBe(true);
  });

  it('expands important sections by default', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', tone: 'important', fields: [] }]);
    expect(sections[0].expanded).toBe(true);
  });

  it('keeps warning sections explicit rather than auto-expanding', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'S', tone: 'warning', fields: [] }]);
    expect(sections[0].expanded).toBe(false);
  });

  it('counts only populated fields in section summaries', () => {
    const sections = normalizeResultDetailSections([{ id: 's', label: 'Kimlik', fields: [
      { id: 'a', label: 'A', value: 'x' }, { id: 'b', label: 'B', value: null },
    ] }]);
    expect(sections[0].populatedFieldCount).toBe(1);
    expect(sections[0].summary).toBe('Kimlik, 1 dolu alan');
  });

  it('selects requested section when it exists', () => {
    const model = createResultDetailExperienceModel(base({ selectedSectionId: 'second', sections: [
      { id: 'first', label: 'First', fields: [] }, { id: 'second', label: 'Second', fields: [] },
    ] }));
    expect(model.selectedSectionId).toBe('second');
  });

  it('falls back to first section for stale selection', () => {
    const model = createResultDetailExperienceModel(base({ selectedSectionId: 'missing' }));
    expect(model.selectedSectionId).toBe('general');
  });

  it('supports a detail with no sections', () => {
    const model = createResultDetailExperienceModel(base({ sections: [] }));
    expect(model.sections).toHaveLength(0);
    expect(model.selectedSectionId).toBeNull();
  });

  it('announces busy state', () => {
    expect(createResultDetailExperienceModel(base({ busy: true })).statusAnnouncement).toContain('yükleniyor');
  });

  it('prioritizes safe error announcement over busy state', () => {
    const model = createResultDetailExperienceModel(base({ busy: true, error: 'Sunucu yanıt vermedi' }));
    expect(model.statusAnnouncement).toContain('Ayrıntı yüklenemedi');
    expect(model.statusAnnouncement).toContain('Sunucu yanıt vermedi');
  });

  it('redacts URLs and credential-shaped fragments from errors', () => {
    const model = createResultDetailExperienceModel(base({ error: 'Failed https://secret.test/a token=supersecret' }));
    expect(model.error).not.toContain('secret.test');
    expect(model.error).not.toContain('supersecret');
    expect(model.error).toContain('[bağlantı gizlendi]');
  });

  it('bounds title, subtitle and error text', () => {
    const model = createResultDetailExperienceModel(base({ title: 'x'.repeat(500), subtitle: 'y'.repeat(500), error: 'z'.repeat(500) }));
    expect(model.title.length).toBeLessThanOrEqual(140);
    expect(model.subtitle?.length).toBeLessThanOrEqual(140);
    expect(model.error?.length).toBeLessThanOrEqual(180);
  });

  it('removes control characters from user-facing strings', () => {
    const model = createResultDetailExperienceModel(base({ title: 'Park\u0000\nAdı' }));
    expect(model.title).toBe('Park Adı');
  });

  it('sanitizes result identity for DOM-safe correlation', () => {
    const model = createResultDetailExperienceModel(base({ resultId: ' feature / 42 ' }));
    expect(model.resultId).toBe('feature---42');
  });

  it('falls back for empty result identity and title', () => {
    const model = createResultDetailExperienceModel(base({ resultId: ' ', title: ' ' }));
    expect(model.resultId).toBe('result');
    expect(model.title).toBe('Sonuç ayrıntısı');
  });

  it('moves section focus down with wraparound', () => {
    expect(resolveResultDetailKeyboard({ key: 'ArrowDown', currentSectionIndex: 2, sectionCount: 3 })).toMatchObject({ handled: true, nextSectionIndex: 0, action: 'focus-section' });
  });

  it('moves section focus up with wraparound', () => {
    expect(resolveResultDetailKeyboard({ key: 'ArrowUp', currentSectionIndex: 0, sectionCount: 3 })).toMatchObject({ handled: true, nextSectionIndex: 2, action: 'focus-section' });
  });

  it('supports Home and End section navigation', () => {
    expect(resolveResultDetailKeyboard({ key: 'Home', currentSectionIndex: 1, sectionCount: 3 }).nextSectionIndex).toBe(0);
    expect(resolveResultDetailKeyboard({ key: 'End', currentSectionIndex: 1, sectionCount: 3 }).nextSectionIndex).toBe(2);
  });

  it('toggles focused section with Enter and Space', () => {
    expect(resolveResultDetailKeyboard({ key: 'Enter', currentSectionIndex: 1, sectionCount: 3 }).action).toBe('toggle-section');
    expect(resolveResultDetailKeyboard({ key: ' ', currentSectionIndex: 1, sectionCount: 3 }).action).toBe('toggle-section');
  });

  it('maps Escape to close even when no sections exist', () => {
    expect(resolveResultDetailKeyboard({ key: 'Escape', currentSectionIndex: null, sectionCount: 0 })).toMatchObject({ handled: true, action: 'close' });
  });

  it('ignores unsupported keys without stealing keyboard events', () => {
    expect(resolveResultDetailKeyboard({ key: 'Tab', currentSectionIndex: 1, sectionCount: 3 })).toMatchObject({ handled: false, action: 'none', nextSectionIndex: 1 });
  });

  it('does not handle section navigation for an empty section list', () => {
    expect(resolveResultDetailKeyboard({ key: 'ArrowDown', currentSectionIndex: null, sectionCount: 0 })).toEqual({ handled: false, nextSectionIndex: null, action: 'none' });
  });

  it('clamps hostile current section indexes', () => {
    expect(resolveResultDetailKeyboard({ key: 'Enter', currentSectionIndex: 999, sectionCount: 3 }).nextSectionIndex).toBe(2);
    expect(resolveResultDetailKeyboard({ key: 'Enter', currentSectionIndex: -20, sectionCount: 3 }).nextSectionIndex).toBe(0);
  });

  it('preserves section focus when the section survives refresh', () => {
    const sections = normalizeResultDetailSections([{ id: 'a', label: 'A', fields: [] }, { id: 'b', label: 'B', fields: [] }]);
    expect(resolveResultDetailFocusTarget('b', sections)).toBe('b');
  });

  it('falls focus back to first section after removal', () => {
    const sections = normalizeResultDetailSections([{ id: 'a', label: 'A', fields: [] }]);
    expect(resolveResultDetailFocusTarget('removed', sections)).toBe('a');
  });

  it('returns null focus target for empty detail', () => {
    expect(resolveResultDetailFocusTarget('removed', [])).toBeNull();
  });

  it('announces initial detail opening', () => {
    const next = createResultDetailExperienceModel(base());
    expect(describeResultDetailChange(null, next)).toBe('Atatürk Parkı ayrıntıları açıldı');
  });

  it('announces navigation to a different result', () => {
    const previous = createResultDetailExperienceModel(base());
    const next = createResultDetailExperienceModel(base({ resultId: 'other', title: 'Başka Sonuç' }));
    expect(describeResultDetailChange(previous, next)).toBe('Başka Sonuç ayrıntıları açıldı');
  });

  it('announces newly surfaced errors', () => {
    const previous = createResultDetailExperienceModel(base());
    const next = createResultDetailExperienceModel(base({ error: 'Geçici hata' }));
    expect(describeResultDetailChange(previous, next)).toBe('Ayrıntı hatası: Geçici hata');
  });

  it('announces completion after busy state', () => {
    const previous = createResultDetailExperienceModel(base({ busy: true }));
    const next = createResultDetailExperienceModel(base({ busy: false }));
    expect(describeResultDetailChange(previous, next)).toBe('Atatürk Parkı ayrıntıları yüklendi');
  });

  it('announces selected section changes', () => {
    const sections = [{ id: 'a', label: 'A', fields: [] }, { id: 'b', label: 'B', fields: [] }];
    const previous = createResultDetailExperienceModel(base({ sections, selectedSectionId: 'a' }));
    const next = createResultDetailExperienceModel(base({ sections, selectedSectionId: 'b' }));
    expect(describeResultDetailChange(previous, next)).toBe('B bölümü seçildi');
  });

  it('stays silent when no meaningful accessible state changed', () => {
    const previous = createResultDetailExperienceModel(base());
    const next = createResultDetailExperienceModel(base());
    expect(describeResultDetailChange(previous, next)).toBeNull();
  });
});
