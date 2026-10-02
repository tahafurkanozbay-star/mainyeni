export type WorkspaceLivePriority = 'polite' | 'assertive';
export type WorkspaceLiveTopic = 'map' | 'connectivity' | 'navigation' | 'dialog' | 'command' | 'selection' | 'system';

export interface WorkspaceLiveMessage {
  readonly id: string;
  readonly topic: WorkspaceLiveTopic;
  readonly priority: WorkspaceLivePriority;
  readonly text: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly fingerprint: string;
}

export interface WorkspaceLiveRegionState {
  readonly polite: readonly WorkspaceLiveMessage[];
  readonly assertive: readonly WorkspaceLiveMessage[];
  readonly recentFingerprints: Readonly<Record<string, number>>;
  readonly sequence: number;
}

export interface WorkspaceLiveInput {
  readonly topic: WorkspaceLiveTopic;
  readonly priority?: WorkspaceLivePriority;
  readonly text: string;
  readonly now: number;
  readonly ttlMs?: number;
  readonly dedupeMs?: number;
}

const MAX_QUEUE = 6;
const MAX_TEXT = 240;
const DEFAULT_TTL = 12_000;
const DEFAULT_DEDUPE = 1_500;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.trunc(value)));
const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const fingerprint = (topic: WorkspaceLiveTopic, text: string): string => `${topic}:${text.toLocaleLowerCase('tr-TR')}`;
const freezeQueue = (items: readonly WorkspaceLiveMessage[]): readonly WorkspaceLiveMessage[] => Object.freeze([...items]);

export const createWorkspaceLiveRegionState = (): WorkspaceLiveRegionState => Object.freeze({
  polite: Object.freeze([]),
  assertive: Object.freeze([]),
  recentFingerprints: Object.freeze({}),
  sequence: 0,
});

export const pruneWorkspaceLiveRegion = (state: WorkspaceLiveRegionState, now: number): WorkspaceLiveRegionState => {
  const safeNow = Number.isFinite(now) ? now : 0;
  const polite = state.polite.filter((message) => message.expiresAt > safeNow);
  const assertive = state.assertive.filter((message) => message.expiresAt > safeNow);
  const recentFingerprints = Object.fromEntries(Object.entries(state.recentFingerprints).filter(([, expiresAt]) => expiresAt > safeNow));
  if (polite.length === state.polite.length && assertive.length === state.assertive.length && Object.keys(recentFingerprints).length === Object.keys(state.recentFingerprints).length) return state;
  return Object.freeze({ polite: freezeQueue(polite), assertive: freezeQueue(assertive), recentFingerprints: Object.freeze(recentFingerprints), sequence: state.sequence + 1 });
};

export const enqueueWorkspaceLiveMessage = (state: WorkspaceLiveRegionState, input: WorkspaceLiveInput): WorkspaceLiveRegionState => {
  const text = normalizeText(input.text);
  if (!text) return state;
  const now = Number.isFinite(input.now) ? input.now : 0;
  const priority = input.priority ?? 'polite';
  const ttlMs = clamp(input.ttlMs ?? DEFAULT_TTL, 500, 60_000);
  const dedupeMs = clamp(input.dedupeMs ?? DEFAULT_DEDUPE, 0, 30_000);
  const clean = pruneWorkspaceLiveRegion(state, now);
  const key = fingerprint(input.topic, text);
  if ((clean.recentFingerprints[key] ?? 0) > now) return clean;
  const sequence = clean.sequence + 1;
  const message: WorkspaceLiveMessage = Object.freeze({ id: `workspace-live-${sequence}`, topic: input.topic, priority, text, createdAt: now, expiresAt: now + ttlMs, fingerprint: key });
  const target = priority === 'assertive' ? clean.assertive : clean.polite;
  const bounded = freezeQueue([...target, message].slice(-MAX_QUEUE));
  const recentFingerprints = Object.freeze({ ...clean.recentFingerprints, [key]: now + dedupeMs });
  return Object.freeze({ polite: priority === 'polite' ? bounded : clean.polite, assertive: priority === 'assertive' ? bounded : clean.assertive, recentFingerprints, sequence });
};

export const consumeWorkspaceLiveMessage = (state: WorkspaceLiveRegionState, priority: WorkspaceLivePriority): { readonly state: WorkspaceLiveRegionState; readonly message: WorkspaceLiveMessage | null } => {
  const queue = priority === 'assertive' ? state.assertive : state.polite;
  const message = queue[0] ?? null;
  if (!message) return { state, message: null };
  const rest = freezeQueue(queue.slice(1));
  return { state: Object.freeze({ ...state, [priority]: rest, sequence: state.sequence + 1 }), message };
};

export const replaceWorkspaceTopicAnnouncement = (state: WorkspaceLiveRegionState, input: WorkspaceLiveInput): WorkspaceLiveRegionState => {
  const priority = input.priority ?? 'polite';
  const filtered = (priority === 'assertive' ? state.assertive : state.polite).filter((message) => message.topic !== input.topic);
  const base = Object.freeze({ ...state, [priority]: freezeQueue(filtered) });
  return enqueueWorkspaceLiveMessage(base, input);
};

export const clearWorkspaceLiveTopic = (state: WorkspaceLiveRegionState, topic: WorkspaceLiveTopic): WorkspaceLiveRegionState => {
  const polite = state.polite.filter((message) => message.topic !== topic);
  const assertive = state.assertive.filter((message) => message.topic !== topic);
  if (polite.length === state.polite.length && assertive.length === state.assertive.length) return state;
  return Object.freeze({ ...state, polite: freezeQueue(polite), assertive: freezeQueue(assertive), sequence: state.sequence + 1 });
};

export const workspaceLiveRegionText = (state: WorkspaceLiveRegionState, priority: WorkspaceLivePriority): string => (priority === 'assertive' ? state.assertive[0]?.text : state.polite[0]?.text) ?? '';

export const workspaceLiveRegionSnapshot = (state: WorkspaceLiveRegionState): Readonly<{ politeCount: number; assertiveCount: number; hasUrgentMessage: boolean }> => Object.freeze({ politeCount: state.polite.length, assertiveCount: state.assertive.length, hasUrgentMessage: state.assertive.length > 0 });
