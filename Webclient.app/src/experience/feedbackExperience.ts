export type FeedbackTone = 'neutral' | 'success' | 'warning' | 'danger';
export type FeedbackPriority = 'polite' | 'assertive';
export type FeedbackPlacement = 'inline' | 'toast' | 'banner';

export interface FeedbackInput {
  id: string;
  title: string;
  message?: string | null;
  tone?: FeedbackTone;
  priority?: FeedbackPriority;
  placement?: FeedbackPlacement;
  dismissible?: boolean;
  actionLabel?: string | null;
  createdAt?: number;
  expiresAt?: number | null;
}

export interface FeedbackViewModel {
  id: string;
  title: string;
  message: string | null;
  tone: FeedbackTone;
  priority: FeedbackPriority;
  placement: FeedbackPlacement;
  dismissible: boolean;
  actionLabel: string | null;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  semanticId: string;
  expired: boolean;
}

const MAX_ID = 80;
const MAX_TITLE = 120;
const MAX_MESSAGE = 320;
const MAX_ACTION = 64;
const CONTROL_CHARACTER_PATTERN = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

const clean = (value: unknown, max: number): string => {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARACTER_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
};

const slug = (value: string): string => {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'feedback';
};

export const createFeedbackViewModel = (
  input: FeedbackInput,
  now = Date.now(),
): FeedbackViewModel | null => {
  const id = clean(input.id, MAX_ID);
  const title = clean(input.title, MAX_TITLE);
  if (!id || !title) return null;

  const message = clean(input.message, MAX_MESSAGE) || null;
  const actionLabel = clean(input.actionLabel, MAX_ACTION) || null;
  const tone: FeedbackTone = input.tone ?? 'neutral';
  const priority: FeedbackPriority = input.priority ?? (tone === 'danger' ? 'assertive' : 'polite');
  const placement: FeedbackPlacement = input.placement ?? 'toast';
  const expiresAt = Number.isFinite(input.expiresAt) ? Number(input.expiresAt) : null;

  return {
    id,
    title,
    message,
    tone,
    priority,
    placement,
    dismissible: input.dismissible ?? placement === 'toast',
    actionLabel,
    role: priority === 'assertive' ? 'alert' : 'status',
    ariaLive: priority,
    semanticId: `kr-feedback-${slug(id)}`,
    expired: expiresAt !== null && expiresAt <= now,
  };
};

export interface FeedbackQueueOptions {
  maxVisible?: number;
  maxQueued?: number;
}

export class FeedbackQueue {
  private readonly maxVisible: number;
  private readonly maxQueued: number;
  private readonly items = new Map<string, FeedbackInput>();

  constructor(options: FeedbackQueueOptions = {}) {
    this.maxVisible = Math.max(1, Math.min(5, Math.trunc(options.maxVisible ?? 3)));
    this.maxQueued = Math.max(this.maxVisible, Math.min(50, Math.trunc(options.maxQueued ?? 12)));
  }

  push(input: FeedbackInput): void {
    const model = createFeedbackViewModel(input);
    if (!model || model.expired) return;
    this.items.delete(model.id);
    this.items.set(model.id, { ...input, id: model.id, title: model.title });
    while (this.items.size > this.maxQueued) {
      const oldest = this.items.keys().next().value as string | undefined;
      if (!oldest) break;
      this.items.delete(oldest);
    }
  }

  dismiss(id: string): boolean {
    return this.items.delete(clean(id, MAX_ID));
  }

  clear(): void {
    this.items.clear();
  }

  snapshot(now = Date.now()): FeedbackViewModel[] {
    const models: FeedbackViewModel[] = [];
    for (const [id, item] of this.items) {
      const model = createFeedbackViewModel(item, now);
      if (!model || model.expired) {
        this.items.delete(id);
        continue;
      }
      models.push(model);
    }
    return models.slice(-this.maxVisible);
  }

  get size(): number {
    return this.items.size;
  }
}

export interface FeedbackKeyboardEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

export type FeedbackKeyboardIntent =
  | { type: 'dismiss-latest' }
  | { type: 'focus-latest-action' }
  | null;

const isEditable = (target: FeedbackKeyboardEventLike['target']): boolean => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
};

export const resolveFeedbackKeyboardIntent = (
  event: FeedbackKeyboardEventLike,
): FeedbackKeyboardIntent => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    isEditable(event.target) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) return null;

  if (event.key === 'Escape') return { type: 'dismiss-latest' };
  if (event.key === 'F6' && event.shiftKey) return { type: 'focus-latest-action' };
  return null;
};
