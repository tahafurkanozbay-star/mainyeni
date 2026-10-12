import {
  NUMBERING_LEVELS_V11,
  numberingLevelLabelV11,
  selectionPathCompleteV11,
  type NumberingLevelV11,
  type NumberingRuntimeSnapshotV11,
} from './NumberingQueryContractsV11';

export type NumberingAuditSeverityV11 = 'info' | 'warning' | 'error';

export interface NumberingAuditFindingV11 {
  readonly code: string;
  readonly severity: NumberingAuditSeverityV11;
  readonly level: NumberingLevelV11 | null;
  readonly message: string;
}

export interface NumberingAuditReportV11 {
  readonly valid: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly findings: readonly NumberingAuditFindingV11[];
  readonly fingerprint: string;
}

const finding = (
  code: string,
  severity: NumberingAuditSeverityV11,
  level: NumberingLevelV11 | null,
  message: string,
): NumberingAuditFindingV11 => Object.freeze({
  code,
  severity,
  level,
  message,
});

const hash = (input: string): string => {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, '0');
};

const selectedHierarchyFinding = (
  snapshot: NumberingRuntimeSnapshotV11,
  level: NumberingLevelV11,
): NumberingAuditFindingV11 | null => {
  if (level === 'district') return null;
  const previous = level === 'neighborhood'
    ? 'district'
    : level === 'street'
      ? 'neighborhood'
      : 'street';
  if (snapshot.levels[level].selected && !snapshot.levels[previous].selected) {
    return finding(
      'hierarchy-parent-missing',
      'error',
      level,
      `${numberingLevelLabelV11(level)} seçiliyken üst adres seviyesi seçili değil.`,
    );
  }
  return null;
};

export const auditNumberingSnapshotV11 = (
  snapshot: NumberingRuntimeSnapshotV11,
): NumberingAuditReportV11 => {
  const findings: NumberingAuditFindingV11[] = [];

  for (const level of NUMBERING_LEVELS_V11) {
    const state = snapshot.levels[level];
    const hierarchy = selectedHierarchyFinding(snapshot, level);
    if (hierarchy) findings.push(hierarchy);

    if (state.visibleOptionCount > state.optionCount) {
      findings.push(finding(
        'visible-count-exceeds-source',
        'error',
        level,
        'Görünür seçenek sayısı toplam seçenek sayısını aşıyor.',
      ));
    }

    if (state.options.length !== state.visibleOptionCount) {
      findings.push(finding(
        'visible-count-mismatch',
        'error',
        level,
        'Snapshot içindeki görünür seçenek sayısı ile options uzunluğu eşleşmiyor.',
      ));
    }

    const seen = new Set<string>();
    for (const option of state.options) {
      if (!option.value) {
        findings.push(finding(
          'empty-option-id',
          'error',
          level,
          'Görünür seçeneklerden birinin kimliği boş.',
        ));
        continue;
      }
      if (seen.has(option.value)) {
        findings.push(finding(
          'duplicate-visible-option',
          'error',
          level,
          `Görünür seçeneklerde yinelenen kimlik var: ${option.value}`,
        ));
      }
      seen.add(option.value);
      if (!option.label) {
        findings.push(finding(
          'empty-option-label',
          'warning',
          level,
          `Seçenek etiketi boş: ${option.value}`,
        ));
      }
    }

    if (state.selected && state.selected.value.length === 0) {
      findings.push(finding(
        'empty-selection-id',
        'error',
        level,
        'Seçili değer kimliği boş.',
      ));
    }

    if (state.status === 'loading' && state.error) {
      findings.push(finding(
        'loading-with-error',
        'warning',
        level,
        'Seviye yüklenirken aynı anda hata metni taşıyor.',
      ));
    }

    if (state.truncated && !state.message && state.options.length === state.optionCount) {
      findings.push(finding(
        'unexplained-truncation',
        'warning',
        level,
        'Truncation işaretli ancak kullanıcıya açıklama sunulmuyor.',
      ));
    }

    if (state.filter.length > 500) {
      findings.push(finding(
        'filter-length-overflow',
        'error',
        level,
        'Filtre değeri hard güvenlik sınırını aşıyor.',
      ));
    }
  }

  if (snapshot.complete !== selectionPathCompleteV11(snapshot.path)) {
    findings.push(finding(
      'completion-mismatch',
      'error',
      null,
      'Tamamlanma bayrağı seçili adres yoluyla uyuşmuyor.',
    ));
  }

  if (snapshot.complete && !snapshot.pathLabel) {
    findings.push(finding(
      'complete-without-label',
      'error',
      null,
      'Tamamlanmış adres seçiminin okunabilir path etiketi yok.',
    ));
  }

  if (snapshot.busy && snapshot.activeLevel === null) {
    findings.push(finding(
      'busy-without-active-level',
      'error',
      null,
      'Runtime busy görünürken aktif yükleme seviyesi yok.',
    ));
  }

  if (!snapshot.busy && snapshot.activeLevel !== null) {
    findings.push(finding(
      'active-level-without-busy',
      'error',
      snapshot.activeLevel,
      'Aktif yükleme seviyesi varken runtime busy değil.',
    ));
  }

  if (snapshot.disposed) {
    const retainedOptions = NUMBERING_LEVELS_V11.reduce(
      (total, level) => total + snapshot.levels[level].optionCount,
      0,
    );
    if (retainedOptions > 0) {
      findings.push(finding(
        'disposed-retains-options',
        'error',
        null,
        'Dispose edilmiş runtime seçenek verisi tutmaya devam ediyor.',
      ));
    }
    if (snapshot.history.length > 0) {
      findings.push(finding(
        'disposed-retains-history',
        'warning',
        null,
        'Dispose edilmiş runtime history tutuyor.',
      ));
    }
  }

  if (snapshot.metrics.staleResponses > snapshot.metrics.requests) {
    findings.push(finding(
      'stale-count-exceeds-requests',
      'error',
      null,
      'Stale response sayısı toplam request sayısını aşıyor.',
    ));
  }

  if (snapshot.metrics.successes + snapshot.metrics.failures > snapshot.metrics.requests) {
    findings.push(finding(
      'settled-count-exceeds-requests',
      'error',
      null,
      'Başarılı ve başarısız request toplamı request sayısını aşıyor.',
    ));
  }

  if (findings.length === 0) {
    findings.push(finding(
      'snapshot-consistent',
      'info',
      null,
      'Adres runtime snapshot bütünlük kontrollerinden geçti.',
    ));
  }

  const errorCount = findings.filter(item => item.severity === 'error').length;
  const warningCount = findings.filter(item => item.severity === 'warning').length;
  const infoCount = findings.filter(item => item.severity === 'info').length;
  const fingerprintSource = findings
    .map(item => [item.code, item.severity, item.level ?? '', item.message].join('|'))
    .join('\n');

  return Object.freeze({
    valid: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings: Object.freeze(findings),
    fingerprint: hash(fingerprintSource),
  });
};
