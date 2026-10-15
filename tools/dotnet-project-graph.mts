import path from 'node:path';

/**
 * Deterministic iterative audit of in-repository MSBuild ProjectReference cycles.
 * The package-governance pass already validates missing, self and escaping edges.
 * Conditional references are included conservatively for graph review.
 */
export const auditDotnetProjectCycles = projects => {
  const projectPaths = new Set(projects.map(project => project.path.replaceAll('\\', '/')));
  const adjacency = new Map();
  for (const project of projects) {
    const source = project.path.replaceAll('\\', '/');
    const directory = path.posix.dirname(source);
    const targets = new Set();
    for (const reference of project.projectReferences) {
      const target = path.posix.normalize(path.posix.join(directory, reference.replaceAll('\\', '/')));
      if (target !== source && projectPaths.has(target)) targets.add(target);
    }
    adjacency.set(source, [...targets].sort());
  }

  const states = new Map(); // 1 = active, 2 = completed
  const active = [];
  const activeIndex = new Map();
  const findings = [];
  const reported = new Set();
  for (const root of [...adjacency.keys()].sort()) {
    if (states.has(root)) continue;
    const frames = [];
    const enter = source => {
      states.set(source, 1);
      activeIndex.set(source, active.length);
      active.push(source);
      frames.push({ source, targets: adjacency.get(source) ?? [], next: 0 });
    };
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next >= frame.targets.length) {
        frames.pop();
        active.pop();
        activeIndex.delete(frame.source);
        states.set(frame.source, 2);
        continue;
      }
      const target = frame.targets[frame.next++];
      const state = states.get(target) ?? 0;
      if (state === 0) {
        enter(target);
      } else if (state === 1) {
        const cycle = [...active.slice(activeIndex.get(target)), target];
        const signature = cycle.join(' -> ');
        if (reported.has(signature)) continue;
        reported.add(signature);
        // Keep reports bounded even when a broken graph has thousands of projects.
        const shown = cycle.slice(0, 16);
        const detail = shown.join(' -> ') +
          (cycle.length > shown.length ? ' -> ... (' + (cycle.length - 1) + ' edges in cycle)' : '');
        findings.push(Object.freeze({
          code: 'project-reference-cycle',
          severity: 'error',
          file: frame.source,
          package: null,
          message: 'ProjectReference dependency cycle: ' + detail,
        }));
      }
    }
  }
  return Object.freeze(findings.sort((a, b) =>
    a.file.localeCompare(b.file) || a.message.localeCompare(b.message)));
};
