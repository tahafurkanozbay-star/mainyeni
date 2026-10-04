import type { ResultWorkspaceSnapshot } from './ArcGisResultWorkspaceExperiencePolicy';

export type WorkspaceStatusTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';
export type WorkspaceStatusRole = 'status' | 'alert';
export type WorkspaceStatusFocusAction = 'none' | 'focus-collection' | 'focus-recovery';

export interface WorkspaceStatusAccessibilityInput {
  resultCount?: number;
  queryLabel?: string | null;
  errorMessage?: string | null;
  recoveryAvailable?: boolean;
  previousStatus?: string | null;
  scopeId?: string;
}

export interface WorkspaceStatusAccessibilityContract {
  scopeId: string;
  containerId: string;
  headingId: string;
  descriptionId: string;
  recoveryId: string;
  role: WorkspaceStatusRole;
  ariaLive: 'polite' | 'assertive';
  ariaAtomic: true;
  busy: boolean;
  tone: WorkspaceStatusTone;
  message: string;
  description: string;
  recoveryVisible: boolean;
  recoveryLabel: string;
  focusAction: WorkspaceStatusFocusAction;
  focusTarget: string | null;
  minimumTargetSize: 44 | 48;
  reducedMotion: boolean;
  forcedColors: boolean;
  focusVisible: boolean;
  revision: number;
}

const MAX_MESSAGE = 240;
const MAX_QUERY = 80;
const DEFAULT_SCOPE = 'results';

const sanitizeId = (value: string, fallback: string): string => {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return normalized || fallback;
};

const boundedText = (value: string | null | undefined, max = MAX_MESSAGE): string => {
  if (!value) return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
};

const normalizedStatus = (snapshot: ResultWorkspaceSnapshot): string => boundedText(String(snapshot.model?.status ?? 'idle'), 32).toLocaleLowerCase('tr-TR');
const isLoading = (status: string): boolean => ['loading', 'pending', 'refreshing'].includes(status);
const isError = (status: string): boolean => ['error', 'failed', 'failure'].includes(status);
const isEmpty = (status: string, resultCount: number): boolean => ['empty', 'no-results'].includes(status) || (status === 'ready' && resultCount === 0);

const resultCountFrom = (snapshot: ResultWorkspaceSnapshot, explicit?: number): number => {
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(20_000, Math.trunc(explicit as number)));
  return Math.min(20_000, snapshot.interaction?.resultIds?.length ?? 0);
};

const querySuffix = (queryLabel?: string | null): string => {
  const query = boundedText(queryLabel, MAX_QUERY);
  return query ? ` “${query}” için` : '';
};

const messageFor = (status: string, count: number, queryLabel?: string | null, errorMessage?: string | null): {
  message: string; description: string; tone: WorkspaceStatusTone; role: WorkspaceStatusRole; live: 'polite' | 'assertive';
} => {
  if (isError(status)) return {
    message: boundedText(errorMessage) || 'Sonuçlar yüklenemedi.',
    description: 'Bağlantınızı kontrol edip yeniden deneyin. Harita üzerindeki mevcut içerik kullanılmaya devam edebilir.',
    tone: 'danger', role: 'alert', live: 'assertive',
  };
  if (isLoading(status)) return {
    message: `Sonuçlar${querySuffix(queryLabel)} yükleniyor.`,
    description: 'Arama tamamlanırken mevcut odak konumu korunur.',
    tone: 'progress', role: 'status', live: 'polite',
  };
  if (isEmpty(status, count)) return {
    message: `${querySuffix(queryLabel).trimStart() || 'Bu arama için'} sonuç bulunamadı.`,
    description: 'Filtreleri azaltın, arama ifadesini değiştirin veya haritada farklı bir alan deneyin.',
    tone: 'warning', role: 'status', live: 'polite',
  };
  if (status === 'ready') return {
    message: count === 1 ? '1 sonuç hazır.' : `${count.toLocaleString('tr-TR')} sonuç hazır.`,
    description: 'Sonuçlar klavye, tablo veya harita üzerinden incelenebilir.',
    tone: 'success', role: 'status', live: 'polite',
  };
  return {
    message: 'Sonuç alanı hazır.', description: 'Arama yaptığınızda sonuçlar burada gösterilir.',
    tone: 'neutral', role: 'status', live: 'polite',
  };
};

export const createArcGisResultWorkspaceStatusAccessibilityContract = (
  snapshot: ResultWorkspaceSnapshot,
  input: WorkspaceStatusAccessibilityInput = {},
  previous: WorkspaceStatusAccessibilityContract | null = null,
): WorkspaceStatusAccessibilityContract => {
  const scopeId = sanitizeId(input.scopeId ?? DEFAULT_SCOPE, DEFAULT_SCOPE);
  const status = normalizedStatus(snapshot);
  const count = resultCountFrom(snapshot, input.resultCount);
  const copy = messageFor(status, count, input.queryLabel, input.errorMessage);
  const recoveryVisible = isError(status) && input.recoveryAvailable !== false;
  const previousStatus = boundedText(input.previousStatus, 32).toLocaleLowerCase('tr-TR');
  const transitionedToError = isError(status) && !isError(previousStatus);
  const transitionedToReady = status === 'ready' && previousStatus !== 'ready';
  const transitionedToEmpty = isEmpty(status, count) && !isEmpty(previousStatus, count);
  let focusAction: WorkspaceStatusFocusAction = 'none';
  let focusTarget: string | null = null;
  if (transitionedToError && recoveryVisible) {
    focusAction = 'focus-recovery'; focusTarget = `${scopeId}-status-recovery`;
  } else if ((transitionedToReady || transitionedToEmpty) && snapshot.modality === 'keyboard') {
    focusAction = 'focus-collection'; focusTarget = `${scopeId}-collection`;
  }
  const changed = !previous || previous.message !== copy.message || previous.busy !== isLoading(status)
    || previous.focusTarget !== focusTarget || previous.recoveryVisible !== recoveryVisible;
  const revision = changed ? (previous?.revision ?? -1) + 1 : (previous?.revision ?? 0);
  return Object.freeze({
    scopeId,
    containerId: `${scopeId}-status`, headingId: `${scopeId}-status-heading`,
    descriptionId: `${scopeId}-status-description`, recoveryId: `${scopeId}-status-recovery`,
    role: copy.role, ariaLive: copy.live, ariaAtomic: true, busy: isLoading(status), tone: copy.tone,
    message: boundedText(copy.message), description: boundedText(copy.description), recoveryVisible,
    recoveryLabel: 'Yeniden dene', focusAction, focusTarget,
    minimumTargetSize: snapshot.accessibility.minimumTargetSize,
    reducedMotion: snapshot.accessibility.reducedMotion,
    forcedColors: snapshot.accessibility.forcedColors,
    focusVisible: snapshot.modality === 'keyboard', revision,
  });
};

export interface WorkspaceStatusKeyEvent {
  key: string; editable?: boolean; composing?: boolean; repeat?: boolean; defaultPrevented?: boolean;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
}
export interface WorkspaceStatusKeyResolution {
  handled: boolean; preventDefault: boolean; action: 'none' | 'retry' | 'focus-results'; focusTarget: string | null;
}
const ignoredKeyContext = (event: WorkspaceStatusKeyEvent): boolean => Boolean(
  event.editable || event.composing || event.repeat || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey,
);
export const resolveArcGisResultWorkspaceStatusAccessibilityKey = (
  contract: WorkspaceStatusAccessibilityContract,
  event: WorkspaceStatusKeyEvent,
): WorkspaceStatusKeyResolution => {
  const none: WorkspaceStatusKeyResolution = { handled: false, preventDefault: false, action: 'none', focusTarget: null };
  if (ignoredKeyContext(event)) return none;
  if ((event.key === 'Enter' || event.key === ' ') && contract.recoveryVisible) {
    return { handled: true, preventDefault: true, action: 'retry', focusTarget: contract.recoveryId };
  }
  if (event.key === 'Escape' && contract.recoveryVisible) {
    return { handled: true, preventDefault: true, action: 'focus-results', focusTarget: `${contract.scopeId}-collection` };
  }
  return none;
};
