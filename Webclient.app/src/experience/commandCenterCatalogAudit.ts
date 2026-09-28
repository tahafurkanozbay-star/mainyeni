export interface CommandCenterCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly description: string;
  readonly shortcut?: string;
  readonly target?: string;
  readonly event?: string;
  readonly disabled?: boolean;
}

export interface CommandCenterCatalogIssue {
  readonly code:
    | 'blank-id'
    | 'duplicate-id'
    | 'blank-label'
    | 'blank-group'
    | 'blank-description'
    | 'duplicate-shortcut'
    | 'missing-action'
    | 'ambiguous-action';
  readonly severity: 'error' | 'warning';
  readonly commandId: string | null;
  readonly message: string;
}

export interface CommandCenterCatalogReport {
  readonly valid: boolean;
  readonly commandCount: number;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly actionableCount: number;
  readonly shortcutCount: number;
  readonly issues: readonly CommandCenterCatalogIssue[];
}

const normalizeText = (value: unknown): string => String(value ?? '').normalize('NFKC').trim();
const normalizeShortcut = (value: unknown): string => normalizeText(value).toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');

const issue = (
  code: CommandCenterCatalogIssue['code'],
  severity: CommandCenterCatalogIssue['severity'],
  commandId: string | null,
  message: string,
): CommandCenterCatalogIssue => Object.freeze({ code, severity, commandId, message });

export const auditCommandCenterCatalog = (
  entries: readonly CommandCenterCatalogEntry[],
): CommandCenterCatalogReport => {
  const issues: CommandCenterCatalogIssue[] = [];
  const ids = new Set<string>();
  const shortcuts = new Map<string, string>();
  let enabledCount = 0;
  let disabledCount = 0;
  let actionableCount = 0;

  for (const entry of entries) {
    const id = normalizeText(entry.id);
    const label = normalizeText(entry.label);
    const group = normalizeText(entry.group);
    const description = normalizeText(entry.description);
    const target = normalizeText(entry.target);
    const event = normalizeText(entry.event);
    const shortcut = normalizeShortcut(entry.shortcut);
    const disabled = entry.disabled === true;

    if (!id) {
      issues.push(issue('blank-id', 'error', null, 'Komut kimliği boş olamaz.'));
    } else if (ids.has(id)) {
      issues.push(issue('duplicate-id', 'error', id, `Tekrarlanan komut kimliği: ${id}`));
    } else {
      ids.add(id);
    }

    if (!label) issues.push(issue('blank-label', 'error', id || null, 'Komut etiketi boş olamaz.'));
    if (!group) issues.push(issue('blank-group', 'error', id || null, 'Komut grubu boş olamaz.'));
    if (!description) issues.push(issue('blank-description', 'warning', id || null, 'Komut açıklaması boş.'));

    if (disabled) disabledCount += 1;
    else enabledCount += 1;

    const hasTarget = Boolean(target);
    const hasEvent = Boolean(event);
    if (!disabled && !hasTarget && !hasEvent) {
      issues.push(issue('missing-action', 'error', id || null, 'Etkin komut target veya event aksiyonu tanımlamalıdır.'));
    }
    if (hasTarget || hasEvent) actionableCount += 1;
    if (hasTarget && hasEvent) {
      issues.push(issue('ambiguous-action', 'warning', id || null, 'Komut hem target hem event tanımlıyor; yürütme sırası bilinçli olmalıdır.'));
    }

    if (shortcut) {
      const existing = shortcuts.get(shortcut);
      if (existing && existing !== id) {
        issues.push(issue(
          'duplicate-shortcut',
          'error',
          id || null,
          `“${shortcut}” kısayolu hem ${existing} hem ${id || 'kimliksiz komut'} için tanımlı.`,
        ));
      } else if (id) {
        shortcuts.set(shortcut, id);
      }
    }
  }

  return Object.freeze({
    valid: issues.every(entry => entry.severity !== 'error'),
    commandCount: entries.length,
    enabledCount,
    disabledCount,
    actionableCount,
    shortcutCount: shortcuts.size,
    issues: Object.freeze(issues),
  });
};

export const assertCommandCenterCatalog = (
  entries: readonly CommandCenterCatalogEntry[],
): CommandCenterCatalogReport => {
  const report = auditCommandCenterCatalog(entries);
  if (!report.valid) {
    const summary = report.issues
      .filter(entry => entry.severity === 'error')
      .slice(0, 6)
      .map(entry => `${entry.code}${entry.commandId ? `:${entry.commandId}` : ''}`)
      .join(', ');
    throw new Error(`Command center catalog contract failed: ${summary}`);
  }
  return report;
};
