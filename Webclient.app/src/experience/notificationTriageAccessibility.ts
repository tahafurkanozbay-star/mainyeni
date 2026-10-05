export type NotificationTriageSurface = 'sheet' | 'panel' | 'floating';
export type NotificationTriageFocusTarget = 'trigger' | 'scope-all' | 'scope-unread' | 'scope-important' | 'first-item' | 'last-item' | 'close';
export type NotificationTriageAccessibilityIntent =
  | { readonly type: 'none' }
  | { readonly type: 'close'; readonly restoreFocus: true }
  | { readonly type: 'focus'; readonly target: NotificationTriageFocusTarget }
  | { readonly type: 'activate' };

export interface NotificationTriageViewportInput {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer?: boolean;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
}

export interface NotificationTriagePresentation {
  readonly surface: NotificationTriageSurface;
  readonly modal: boolean;
  readonly minimumTargetPx: 44 | 48;
  readonly maxVisibleItems: number;
  readonly motion: 'reduced' | 'standard';
  readonly forcedColors: boolean;
  readonly placement: 'bottom' | 'side' | 'overlay';
}

export interface NotificationTriageKeyInput {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly editable?: boolean;
}

const NONE: NotificationTriageAccessibilityIntent = Object.freeze({ type: 'none' });
const MAX_VISIBLE_ITEMS = 12;

const finiteDimension = (value: number, fallback: number): number => (
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
);

const isControlCodePoint = (codePoint: number): boolean => codePoint < 32 || codePoint === 127;

const replaceControlCharacters = (value: string, replacement: string): string => {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && isControlCodePoint(codePoint) ? replacement : character;
  }
  return result;
};

export const resolveNotificationTriagePresentation = (
  input: NotificationTriageViewportInput,
): NotificationTriagePresentation => {
  const width = finiteDimension(input.width, 1280);
  const height = finiteDimension(input.height, 720);
  const coarsePointer = input.coarsePointer === true;
  const minimumTargetPx = coarsePointer ? 48 : 44;
  const rowBudget = Math.max(3, Math.min(MAX_VISIBLE_ITEMS, Math.floor((height - 220) / minimumTargetPx)));

  if (width < 640) {
    return Object.freeze({
      surface: 'sheet',
      modal: true,
      minimumTargetPx,
      maxVisibleItems: rowBudget,
      motion: input.reducedMotion === true ? 'reduced' : 'standard',
      forcedColors: input.forcedColors === true,
      placement: 'bottom',
    });
  }

  if (width < 1100) {
    return Object.freeze({
      surface: 'panel',
      modal: false,
      minimumTargetPx,
      maxVisibleItems: rowBudget,
      motion: input.reducedMotion === true ? 'reduced' : 'standard',
      forcedColors: input.forcedColors === true,
      placement: 'side',
    });
  }

  return Object.freeze({
    surface: 'floating',
    modal: false,
    minimumTargetPx,
    maxVisibleItems: rowBudget,
    motion: input.reducedMotion === true ? 'reduced' : 'standard',
    forcedColors: input.forcedColors === true,
    placement: 'overlay',
  });
};

const hasConflictingModifier = (input: NotificationTriageKeyInput): boolean => (
  input.altKey === true || input.ctrlKey === true || input.metaKey === true
);

export const resolveNotificationTriageAccessibilityIntent = (
  input: NotificationTriageKeyInput,
): NotificationTriageAccessibilityIntent => {
  if (
    input.defaultPrevented === true
    || input.repeat === true
    || input.isComposing === true
    || hasConflictingModifier(input)
  ) return NONE;

  const key = input.key;
  if (key === 'Escape') return Object.freeze({ type: 'close', restoreFocus: true });
  if (input.editable === true) return NONE;
  if (key === 'Enter' || key === ' ') return Object.freeze({ type: 'activate' });
  if (key === 'Home') return Object.freeze({ type: 'focus', target: 'first-item' });
  if (key === 'End') return Object.freeze({ type: 'focus', target: 'last-item' });
  if (key === '1') return Object.freeze({ type: 'focus', target: 'scope-all' });
  if (key === '2') return Object.freeze({ type: 'focus', target: 'scope-unread' });
  if (key === '3') return Object.freeze({ type: 'focus', target: 'scope-important' });
  if (key.toLowerCase() === 'c') return Object.freeze({ type: 'focus', target: 'close' });
  return NONE;
};

const sanitizeIdPart = (value: string, fallback: string): string => {
  let normalized = '';
  let separatorPending = false;
  const filteredInput = Array.from(value, (character) => (
    character === 'İ' || character === 'ı' ? '' : character
  )).join('');
  const source = replaceControlCharacters(filteredInput, '').normalize('NFKD');
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint >= 0x0300 && codePoint <= 0x036f) continue;
    const lower = character === 'I' ? 'i' : character.toLowerCase();
    const lowerCode = lower.codePointAt(0);
    const alphanumeric = lowerCode !== undefined && (
      (lowerCode >= 48 && lowerCode <= 57)
      || (lowerCode >= 97 && lowerCode <= 122)
    );
    if (alphanumeric || lower === '_' || lower === '-') {
      if (separatorPending && normalized && !normalized.endsWith('-')) normalized += '-';
      normalized += lower;
      separatorPending = false;
    } else if (normalized) {
      separatorPending = true;
    }
    if (normalized.length >= 48) break;
  }
  return normalized.replace(/-+$/g, '').slice(0, 48) || fallback;
};

export const notificationTriageSemanticIds = (instanceId: string) => {
  const safe = sanitizeIdPart(instanceId, 'default');
  const prefix = `notification-triage-${safe}`;
  return Object.freeze({
    regionId: `${prefix}-region`,
    headingId: `${prefix}-heading`,
    summaryId: `${prefix}-summary`,
    scopesId: `${prefix}-scopes`,
    listId: `${prefix}-list`,
    statusId: `${prefix}-status`,
  });
};

export interface NotificationTriageAnnouncementInput {
  readonly total: number;
  readonly visible: number;
  readonly unread: number;
  readonly important: number;
  readonly scope: 'all' | 'unread' | 'important';
}

const boundedCount = (value: number): number => (
  Number.isFinite(value) ? Math.max(0, Math.min(999, Math.floor(value))) : 0
);

export const notificationTriageAnnouncement = (
  input: NotificationTriageAnnouncementInput,
): string => {
  const total = boundedCount(input.total);
  const visible = Math.min(total, boundedCount(input.visible));
  const unread = Math.min(total, boundedCount(input.unread));
  const important = Math.min(total, boundedCount(input.important));
  const scopeLabel = input.scope === 'unread'
    ? 'okunmamış'
    : input.scope === 'important'
      ? 'önemli'
      : 'tüm';
  if (total === 0) return 'Bildirim yok.';
  return `${scopeLabel} bildirimler: ${visible} görünür, ${total} toplam, ${unread} okunmamış, ${important} önemli.`;
};

export const notificationTriageItemAriaLabel = (input: {
  readonly title: string;
  readonly read: boolean;
  readonly important: boolean;
  readonly position: number;
  readonly setSize: number;
}): string => {
  const title = replaceControlCharacters(input.title, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Başlıksız bildirim';
  const setSize = Math.max(1, Math.min(96, Math.floor(input.setSize) || 1));
  const position = Math.max(1, Math.min(setSize, Math.floor(input.position) || 1));
  const readState = input.read ? 'okundu' : 'okunmamış';
  const importance = input.important ? ', önemli' : '';
  return `${title}, ${readState}${importance}, ${position}/${setSize}`;
};
