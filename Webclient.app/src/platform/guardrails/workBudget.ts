import type {
  WorkBudgetPolicy,
  WorkBudgetSnapshot,
  WorkTicketSnapshot,
  WorkTicketState,
} from './contracts';

export interface WorkAdmissionRequest {
  readonly key: string;
  readonly priority?: number;
  readonly at?: number;
}

export interface WorkAdmissionTicket {
  readonly id: number;
  readonly key: string;
  readonly state: WorkTicketState;
  readonly admitted: boolean;
}

export interface WorkBudgetController {
  readonly admit: (request: WorkAdmissionRequest) => WorkAdmissionTicket;
  readonly start: (id: number, at?: number) => WorkTicketSnapshot;
  readonly complete: (id: number, at?: number) => WorkTicketSnapshot;
  readonly cancel: (id: number, reason?: string, at?: number) => WorkTicketSnapshot;
  readonly sweep: (at?: number) => readonly WorkTicketSnapshot[];
  readonly snapshot: () => WorkBudgetSnapshot;
  readonly clearCompleted: () => void;
  readonly dispose: () => void;
}

export const DEFAULT_WORK_BUDGET_POLICY: WorkBudgetPolicy = Object.freeze({
  maxConcurrent: 8,
  maxQueued: 128,
  maxPerKey: 2,
  maxWaitMs: 15_000,
  maxRunMs: 60_000,
  maxCompletedHistory: 256,
});

interface MutableTicket {
  id: number;
  key: string;
  priority: number;
  state: WorkTicketState;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  reason: string | null;
}

const positiveInt = (value: number, fallback: number): number => {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
};

const normalizePriority = (value: number | undefined): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.floor(value ?? 0)));
};

export const normalizeWorkBudgetPolicy = (
  input: Partial<WorkBudgetPolicy> = {},
): WorkBudgetPolicy => Object.freeze({
  maxConcurrent: positiveInt(input.maxConcurrent ?? DEFAULT_WORK_BUDGET_POLICY.maxConcurrent, DEFAULT_WORK_BUDGET_POLICY.maxConcurrent),
  maxQueued: positiveInt(input.maxQueued ?? DEFAULT_WORK_BUDGET_POLICY.maxQueued, DEFAULT_WORK_BUDGET_POLICY.maxQueued),
  maxPerKey: positiveInt(input.maxPerKey ?? DEFAULT_WORK_BUDGET_POLICY.maxPerKey, DEFAULT_WORK_BUDGET_POLICY.maxPerKey),
  maxWaitMs: positiveInt(input.maxWaitMs ?? DEFAULT_WORK_BUDGET_POLICY.maxWaitMs, DEFAULT_WORK_BUDGET_POLICY.maxWaitMs),
  maxRunMs: positiveInt(input.maxRunMs ?? DEFAULT_WORK_BUDGET_POLICY.maxRunMs, DEFAULT_WORK_BUDGET_POLICY.maxRunMs),
  maxCompletedHistory: positiveInt(
    input.maxCompletedHistory ?? DEFAULT_WORK_BUDGET_POLICY.maxCompletedHistory,
    DEFAULT_WORK_BUDGET_POLICY.maxCompletedHistory,
  ),
});

const toSnapshot = (ticket: MutableTicket): WorkTicketSnapshot => {
  const queueWaitMs = ticket.startedAt === null
    ? null
    : Math.max(0, ticket.startedAt - ticket.queuedAt);
  const runMs = ticket.startedAt === null || ticket.finishedAt === null
    ? null
    : Math.max(0, ticket.finishedAt - ticket.startedAt);

  return Object.freeze({
    id: ticket.id,
    key: ticket.key,
    priority: ticket.priority,
    state: ticket.state,
    queuedAt: ticket.queuedAt,
    startedAt: ticket.startedAt,
    finishedAt: ticket.finishedAt,
    queueWaitMs,
    runMs,
    reason: ticket.reason,
  });
};

const terminalState = (state: WorkTicketState): boolean =>
  state === 'completed' || state === 'cancelled' || state === 'rejected';

export const createWorkBudgetController = (
  policyInput: Partial<WorkBudgetPolicy> = {},
  now: () => number = Date.now,
): WorkBudgetController => {
  const policy = normalizeWorkBudgetPolicy(policyInput);
  const tickets = new Map<number, MutableTicket>();
  let nextId = 1;
  let disposed = false;
  let rejected = 0;
  let cancelled = 0;
  let completed = 0;

  const assertActive = (): void => {
    if (disposed) throw new Error('Work budget controller is disposed.');
  };

  const timestamp = (value?: number): number => {
    if (value !== undefined && Number.isFinite(value)) return value;
    return now();
  };

  const activeForKey = (key: string): number => {
    let count = 0;
    for (const ticket of tickets.values()) {
      if (ticket.key === key && (ticket.state === 'queued' || ticket.state === 'running')) {
        count += 1;
      }
    }
    return count;
  };

  const runningCount = (): number => {
    let count = 0;
    for (const ticket of tickets.values()) {
      if (ticket.state === 'running') count += 1;
    }
    return count;
  };

  const queuedTickets = (): MutableTicket[] => {
    const result: MutableTicket[] = [];
    for (const ticket of tickets.values()) {
      if (ticket.state === 'queued') result.push(ticket);
    }
    return result;
  };

  const trimHistory = (): void => {
    const terminal = [...tickets.values()]
      .filter((ticket) => terminalState(ticket.state))
      .sort((left, right) => {
        const leftAt = left.finishedAt ?? left.queuedAt;
        const rightAt = right.finishedAt ?? right.queuedAt;
        return leftAt - rightAt || left.id - right.id;
      });

    const excess = terminal.length - policy.maxCompletedHistory;
    if (excess <= 0) return;

    for (let index = 0; index < excess; index += 1) {
      const ticket = terminal[index];
      if (ticket) tickets.delete(ticket.id);
    }
  };

  const makeRejected = (key: string, priority: number, at: number, why: string): WorkAdmissionTicket => {
    const id = nextId;
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    const ticket: MutableTicket = {
      id,
      key,
      priority,
      state: 'rejected',
      queuedAt: at,
      startedAt: null,
      finishedAt: at,
      reason: why,
    };
    tickets.set(id, ticket);
    rejected += 1;
    trimHistory();
    return Object.freeze({ id, key, state: 'rejected', admitted: false });
  };

  const admit = (request: WorkAdmissionRequest): WorkAdmissionTicket => {
    assertActive();
    const key = request.key.trim().slice(0, 256);
    const priority = normalizePriority(request.priority);
    const at = timestamp(request.at);

    if (key.length === 0) {
      return makeRejected('', priority, at, 'empty-key');
    }

    if (activeForKey(key) >= policy.maxPerKey) {
      return makeRejected(key, priority, at, 'per-key-capacity');
    }

    const running = runningCount();
    const queued = queuedTickets().length;
    if (running >= policy.maxConcurrent && queued >= policy.maxQueued) {
      return makeRejected(key, priority, at, 'queue-capacity');
    }

    const id = nextId;
    nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;

    const state: WorkTicketState = running < policy.maxConcurrent ? 'running' : 'queued';
    const ticket: MutableTicket = {
      id,
      key,
      priority,
      state,
      queuedAt: at,
      startedAt: state === 'running' ? at : null,
      finishedAt: null,
      reason: null,
    };
    tickets.set(id, ticket);
    return Object.freeze({ id, key, state, admitted: true });
  };

  const requireTicket = (id: number): MutableTicket => {
    const ticket = tickets.get(id);
    if (!ticket) throw new Error('Unknown work ticket.');
    return ticket;
  };

  const start = (id: number, atInput?: number): WorkTicketSnapshot => {
    assertActive();
    const ticket = requireTicket(id);
    if (ticket.state === 'running') return toSnapshot(ticket);
    if (ticket.state !== 'queued') throw new Error('Only queued work can be started.');
    if (runningCount() >= policy.maxConcurrent) {
      throw new Error('Concurrent work budget is full.');
    }
    const at = timestamp(atInput);
    ticket.state = 'running';
    ticket.startedAt = Math.max(ticket.queuedAt, at);
    return toSnapshot(ticket);
  };

  const promoteQueued = (at: number): void => {
    let available = Math.max(0, policy.maxConcurrent - runningCount());
    if (available <= 0) return;

    const queue = queuedTickets().sort((left, right) =>
      right.priority - left.priority ||
      left.queuedAt - right.queuedAt ||
      left.id - right.id,
    );

    for (const ticket of queue) {
      if (available <= 0) break;
      ticket.state = 'running';
      ticket.startedAt = Math.max(ticket.queuedAt, at);
      available -= 1;
    }
  };

  const complete = (id: number, atInput?: number): WorkTicketSnapshot => {
    assertActive();
    const ticket = requireTicket(id);
    if (ticket.state !== 'running') throw new Error('Only running work can be completed.');
    const at = timestamp(atInput);
    ticket.state = 'completed';
    ticket.finishedAt = Math.max(ticket.startedAt ?? ticket.queuedAt, at);
    completed += 1;
    promoteQueued(ticket.finishedAt);
    trimHistory();
    return toSnapshot(ticket);
  };

  const cancel = (id: number, why = 'cancelled', atInput?: number): WorkTicketSnapshot => {
    assertActive();
    const ticket = requireTicket(id);
    if (terminalState(ticket.state)) return toSnapshot(ticket);
    const at = timestamp(atInput);
    ticket.state = 'cancelled';
    ticket.finishedAt = Math.max(ticket.startedAt ?? ticket.queuedAt, at);
    ticket.reason = why.slice(0, 256);
    cancelled += 1;
    promoteQueued(ticket.finishedAt);
    trimHistory();
    return toSnapshot(ticket);
  };

  const sweep = (atInput?: number): readonly WorkTicketSnapshot[] => {
    assertActive();
    const at = timestamp(atInput);
    const changed: WorkTicketSnapshot[] = [];

    for (const ticket of tickets.values()) {
      if (ticket.state === 'queued' && at - ticket.queuedAt > policy.maxWaitMs) {
        ticket.state = 'cancelled';
        ticket.finishedAt = at;
        ticket.reason = 'wait-deadline';
        cancelled += 1;
        changed.push(toSnapshot(ticket));
      } else if (
        ticket.state === 'running' &&
        ticket.startedAt !== null &&
        at - ticket.startedAt > policy.maxRunMs
      ) {
        ticket.state = 'cancelled';
        ticket.finishedAt = at;
        ticket.reason = 'run-deadline';
        cancelled += 1;
        changed.push(toSnapshot(ticket));
      }
    }

    promoteQueued(at);
    trimHistory();
    return Object.freeze(changed);
  };

  const snapshot = (): WorkBudgetSnapshot => {
    assertActive();
    const values = [...tickets.values()].map(toSnapshot);
    return Object.freeze({
      running: values.filter((ticket) => ticket.state === 'running').length,
      queued: values.filter((ticket) => ticket.state === 'queued').length,
      rejected,
      cancelled,
      completed,
      tickets: Object.freeze(values),
    });
  };

  const clearCompleted = (): void => {
    assertActive();
    for (const [id, ticket] of tickets) {
      if (terminalState(ticket.state)) tickets.delete(id);
    }
  };

  const dispose = (): void => {
    tickets.clear();
    disposed = true;
  };

  return Object.freeze({
    admit,
    start,
    complete,
    cancel,
    sweep,
    snapshot,
    clearCompleted,
    dispose,
  });
};
