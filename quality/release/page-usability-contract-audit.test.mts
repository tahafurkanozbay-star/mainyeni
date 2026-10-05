import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPageUsabilityContracts } from './page-usability-contract-audit.mts';
import { fixtureInventory, type FixtureFileInput } from './test-helpers.mts';

function audit(files: readonly FixtureFileInput[]) {
  return auditPageUsabilityContracts(fixtureInventory(files));
}

function ids(files: readonly FixtureFileInput[]): string[] {
  return audit(files).findings.map(item => item.id);
}

function tsx(path: string, body: string): FixtureFileInput {
  return { path: `Webclient.app/src/${path}`, text: body, kind: 'typescript' };
}

function css(path: string, body: string): FixtureFileInput {
  return { path: `Webclient.app/src/${path}`, text: body, kind: 'css' };
}

function html(path: string, body: string): FixtureFileInput {
  return { path: `Webclient.app/${path}`, text: body, kind: 'html' };
}

test('ignores non-product files and test fixtures', () => {
  const report = audit([
    { path: 'quality/release/example.mts', text: '<main />', kind: 'typescript' },
    tsx('Widget.test.tsx', '<main><h1>Test</h1></main>'),
    { path: 'README.md', text: '<main></main>', kind: 'markdown' },
  ]);
  assert.equal(report.summary.inspectedFiles, 0);
  assert.equal(report.findings.length, 0);
});

test('recognizes semantic page landmarks and headings in a shell', () => {
  const report = audit([
    tsx('App.tsx', `
      export function App() {
        return <>
          <header><h1>Kent Rehberi</h1></header>
          <nav aria-label="Ana menü" />
          <main><h2>Harita çalışma alanı</h2></main>
        </>;
      }
    `),
  ]);
  assert.equal(report.summary.landmarkFiles, 1);
  assert.equal(report.summary.files[0]?.mainLandmarks, 1);
  assert.equal(report.summary.files[0]?.navLandmarks, 1);
  assert.equal(report.summary.files[0]?.headings, 2);
  assert.ok(!report.findings.some(item => item.id.startsWith('page-shell-main')));
});

test('reports a missing main landmark for a page shell', () => {
  const report = audit([
    tsx('App.tsx', `
      export function App() {
        return <div className="workspace"><h1>Kent Rehberi</h1></div>;
      }
    `),
  ]);
  const finding = report.findings.find(item => item.id === 'page-shell-main-landmark-missing');
  assert.equal(finding?.severity, 'medium');
  assert.equal(finding?.blocking, undefined);
});

test('reports duplicate main landmarks for a page shell', () => {
  const report = audit([
    tsx('WorkspacePage.tsx', `
      export const WorkspacePage = () => <>
        <main><h1>Sonuçlar</h1></main>
        <main><h2>Harita</h2></main>
      </>;
    `),
  ]);
  assert.ok(report.findings.some(item => item.id === 'page-shell-main-landmark-duplicated'));
  assert.equal(report.summary.files[0]?.mainLandmarks, 2);
});

test('reports a shell with no discoverable heading contract', () => {
  const report = audit([
    tsx('RootLayout.tsx', `
      export const RootLayout = () => <main><Outlet /></main>;
    `),
  ]);
  assert.ok(report.findings.some(item => item.id === 'page-shell-heading-contract-missing'));
});

test('does not require a main landmark from an ordinary leaf component', () => {
  const report = audit([
    tsx('Components/ResultCard.tsx', `<article><h3>Park</h3></article>`),
  ]);
  assert.ok(!report.findings.some(item => item.id.startsWith('page-shell-main')));
});

test('accepts a named dialog contract', () => {
  const report = audit([
    tsx('Components/ConfirmDialog.tsx', `
      export const ConfirmDialog = () => (
        <div role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <h2 id="confirm-title">Silme onayı</h2>
          <button>İptal</button>
        </div>
      );
    `),
  ]);
  assert.equal(report.summary.dialogFiles, 1);
  assert.ok(!report.findings.some(item => item.id === 'dialog-accessible-name-missing'));
});

test('reports a dialog without an accessible name', () => {
  const report = audit([
    tsx('Components/AnonymousDialog.tsx', `
      export const AnonymousDialog = () => <div role="dialog"><p>İçerik</p></div>;
    `),
  ]);
  const finding = report.findings.find(item => item.id === 'dialog-accessible-name-missing');
  assert.equal(finding?.severity, 'medium');
});

test('reports modal-looking dialog without aria-modal', () => {
  const report = audit([
    tsx('Components/SettingsModal.tsx', `
      export const SettingsModal = () => (
        <div className="modal-overlay" role="dialog" aria-label="Ayarlar">Ayarlar</div>
      );
    `),
  ]);
  assert.ok(report.findings.some(item => item.id === 'modal-dialog-modality-ambiguous'));
});

test('does not force modal semantics on explicitly non-modal dialog surfaces', () => {
  const report = audit([
    tsx('Components/HelpDialog.tsx', `
      export const HelpDialog = () => (
        <section role="dialog" aria-label="Yardım">Yardım</section>
      );
    `),
  ]);
  assert.ok(!report.findings.some(item => item.id === 'modal-dialog-modality-ambiguous'));
});

test('recognizes labelled form controls', () => {
  const report = audit([
    tsx('Components/SearchForm.tsx', `
      export const SearchForm = () => (
        <form>
          <label htmlFor="query">Ara</label>
          <input id="query" name="query" />
          <select aria-label="Kategori"><option>Park</option></select>
        </form>
      );
    `),
  ]);
  assert.equal(report.summary.formFiles, 1);
  assert.equal(report.summary.files[0]?.formControls, 2);
  assert.ok(!report.findings.some(item => item.id === 'form-control-label-contract-missing'));
});

test('reports a file of visually unlabelled form controls', () => {
  const report = audit([
    tsx('Components/RawFilter.tsx', `
      export const RawFilter = () => <form><input /><select><option>A</option></select></form>;
    `),
  ]);
  assert.ok(report.findings.some(item => item.id === 'form-control-label-contract-missing'));
});

test('ignores hidden inputs when evaluating visible labels', () => {
  const report = audit([
    tsx('Components/HiddenToken.tsx', `
      export const HiddenToken = () => <form><input type="hidden" value="x" /></form>;
    `),
  ]);
  assert.ok(!report.findings.some(item => item.id === 'form-control-label-contract-missing'));
});

test('accepts async UI with aria-busy semantics', () => {
  const report = audit([
    tsx('Components/AsyncResults.tsx', `
      export const AsyncResults = ({ isLoading }: { isLoading: boolean }) => (
        <section aria-busy={isLoading}>{isLoading ? 'Yükleniyor' : 'Hazır'}</section>
      );
    `),
  ]);
  assert.ok(!report.findings.some(item => item.id === 'async-status-announcement-contract-missing'));
});

test('accepts async UI with a live status region', () => {
  const report = audit([
    tsx('Components/AsyncStatus.tsx', `
      export const AsyncStatus = ({ pending }: { pending: boolean }) => (
        <div role="status" aria-live="polite">{pending ? 'Bekleniyor' : 'Hazır'}</div>
      );
    `),
  ]);
  assert.equal(report.summary.liveRegionFiles, 1);
  assert.ok(!report.findings.some(item => item.id === 'async-status-announcement-contract-missing'));
});

test('reports async state without status semantics', () => {
  const report = audit([
    tsx('Components/AsyncPanel.tsx', `
      export const AsyncPanel = ({ loading }: { loading: boolean }) => <div>{loading ? '...' : 'Tamam'}</div>;
    `),
  ]);
  const finding = report.findings.find(item => item.id === 'async-status-announcement-contract-missing');
  assert.equal(finding?.severity, 'low');
});

test('accepts safe target blank links', () => {
  const report = audit([
    tsx('Components/ExternalLink.tsx', `<a href="https://example.test" target="_blank" rel="noopener noreferrer">Belge</a>`),
  ]);
  assert.equal(report.summary.files[0]?.targetBlankLinks, 1);
  assert.equal(report.summary.files[0]?.unsafeTargetBlankLinks, 0);
});

test('reports target blank links without noopener', () => {
  const report = audit([
    tsx('Components/UnsafeLink.tsx', `<a href="https://example.test" target="_blank">Belge</a>`),
  ]);
  assert.ok(report.findings.some(item => item.id === 'external-target-blank-rel-missing'));
});

test('accepts a zoom-friendly viewport', () => {
  const report = audit([
    html('index.html', `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>`),
  ]);
  assert.equal(report.summary.files[0]?.zoomRestrictions, 0);
  assert.ok(!report.findings.some(item => item.id === 'viewport-user-zoom-disabled'));
});

test('blocks user-scalable=no viewport policy', () => {
  const report = audit([
    html('index.html', `<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">`),
  ]);
  const finding = report.findings.find(item => item.id === 'viewport-user-zoom-disabled');
  assert.equal(finding?.severity, 'high');
  assert.equal(finding?.blocking, true);
});

test('blocks maximum-scale=1 viewport policy', () => {
  const report = audit([
    html('index.html', `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">`),
  ]);
  assert.ok(report.findings.some(item => item.id === 'viewport-user-zoom-disabled' && item.blocking === true));
});

test('reports permanent root scroll lock', () => {
  const report = audit([
    css('styles/global.css', `html, body, #root { height: 100%; overflow: hidden; }`),
  ]);
  assert.equal(report.summary.files[0]?.rootScrollLocks, 1);
  assert.ok(report.findings.some(item => item.id === 'root-scroll-lock-review'));
});

test('does not treat component-scoped overflow as a root lock', () => {
  const report = audit([
    css('styles/panel.css', `.result-list { max-height: 20rem; overflow-y: auto; }`),
  ]);
  assert.equal(report.summary.files[0]?.rootScrollLocks, 0);
});

test('reports button-like selectors with sub-40px dimensions', () => {
  const report = audit([
    css('styles/toolbar.css', `.toolbar-button { width: 32px; height: 32px; }`),
  ]);
  assert.equal(report.summary.files[0]?.smallTouchTargets, 2);
  assert.ok(report.findings.some(item => item.id === 'interactive-touch-target-small'));
});

test('accepts coarse-pointer-friendly minimum target size', () => {
  const report = audit([
    css('styles/toolbar.css', `.toolbar-button { min-width: 44px; min-height: 44px; }`),
  ]);
  assert.equal(report.summary.files[0]?.smallTouchTargets, 0);
});

test('reports near-full legacy vh without a modern viewport unit', () => {
  const report = audit([
    css('styles/workspace.css', `.workspace { min-height: 100vh; }`),
  ]);
  assert.equal(report.summary.files[0]?.legacyViewportUnits, 1);
  assert.ok(report.findings.some(item => item.id === 'mobile-viewport-static-vh'));
});

test('accepts a progressive dvh override', () => {
  const report = audit([
    css('styles/workspace.css', `.workspace { min-height: 100vh; min-height: 100dvh; }`),
  ]);
  assert.equal(report.summary.files[0]?.legacyViewportUnits, 1);
  assert.ok(!report.findings.some(item => item.id === 'mobile-viewport-static-vh'));
});

test('reports fixed surfaces without viewport safety companions as informational review', () => {
  const report = audit([
    css('styles/floating.css', `.floating-control { position: fixed; right: 1rem; bottom: 1rem; }`),
  ]);
  const finding = report.findings.find(item => item.id === 'fixed-surface-viewport-safety-review');
  assert.equal(finding?.severity, 'info');
});

test('accepts fixed surfaces with bounded overflow', () => {
  const report = audit([
    css('styles/dialog.css', `.dialog { position: fixed; max-height: 90dvh; overflow-y: auto; }`),
  ]);
  assert.ok(!report.findings.some(item => item.id === 'fixed-surface-viewport-safety-review'));
});

test('counts html, css and tsx surfaces independently', () => {
  const report = audit([
    html('index.html', '<main><h1>Kent Rehberi</h1></main>'),
    css('styles/app.css', '.app { min-height: 100dvh; }'),
    tsx('Components/Panel.tsx', '<section><h2>Panel</h2></section>'),
  ]);
  assert.equal(report.summary.inspectedFiles, 3);
  assert.deepEqual(report.summary.files.map(item => item.kind).sort(), ['css', 'html', 'tsx']);
});

test('sorts file signals deterministically', () => {
  const report = audit([
    css('z.css', '.z { color: red; }'),
    tsx('b.tsx', '<div />'),
    html('index.html', '<html />'),
    tsx('a.tsx', '<div />'),
  ]);
  assert.deepEqual(report.summary.files.map(item => item.file), [
    'Webclient.app/index.html',
    'Webclient.app/src/a.tsx',
    'Webclient.app/src/b.tsx',
    'Webclient.app/src/z.css',
  ]);
});

test('produces stable finding order independent of fixture order', () => {
  const fixtures = [
    tsx('App.tsx', '<div className="workspace" />'),
    tsx('Components/UnsafeLink.tsx', '<a target="_blank">x</a>'),
    css('styles/global.css', 'body { overflow: hidden; }'),
  ] as const;
  const first = audit(fixtures).findings;
  const second = audit([...fixtures].reverse()).findings;
  assert.deepEqual(
    first.map(item => ({ id: item.id, file: item.location?.file, severity: item.severity })),
    second.map(item => ({ id: item.id, file: item.location?.file, severity: item.severity })),
  );
});

test('keeps finding cardinality bounded to one finding per rule and file', () => {
  const repeatedLinks = Array.from({ length: 50 }, (_, index) => `<a href="/x/${index}" target="_blank">x</a>`).join('\n');
  const report = audit([tsx('Components/ManyLinks.tsx', repeatedLinks)]);
  assert.equal(report.summary.files[0]?.unsafeTargetBlankLinks, 50);
  assert.equal(report.findings.filter(item => item.id === 'external-target-blank-rel-missing').length, 1);
});

test('does not mistake navigation aria role for a main landmark', () => {
  const report = audit([
    tsx('App.tsx', `<div role="navigation" aria-label="Araçlar" />`),
  ]);
  assert.equal(report.summary.files[0]?.navLandmarks, 1);
  assert.equal(report.summary.files[0]?.mainLandmarks, 0);
  assert.ok(report.findings.some(item => item.id === 'page-shell-main-landmark-missing'));
});

test('tracks live-region coverage separately from busy-state signals', () => {
  const report = audit([
    tsx('Components/Status.tsx', `<div role="status" aria-live="polite">Hazır</div>`),
    tsx('Components/Busy.tsx', `<section aria-busy={true}>Yükleniyor</section>`),
  ]);
  assert.equal(report.summary.liveRegionFiles, 1);
  const status = report.summary.files.find(item => item.file.endsWith('Status.tsx'));
  const busy = report.summary.files.find(item => item.file.endsWith('Busy.tsx'));
  assert.equal(status?.liveRegions, 2);
  assert.equal(busy?.busyStates, 1);
});

test('keeps severity policy non-blocking except explicit user zoom denial', () => {
  const report = audit([
    tsx('App.tsx', '<div className="workspace" />'),
    tsx('Components/UnsafeLink.tsx', '<a target="_blank">x</a>'),
    css('styles/global.css', 'body { overflow: hidden; }'),
    css('styles/toolbar.css', '.button { width: 24px; }'),
  ]);
  assert.ok(report.findings.length >= 4);
  assert.ok(report.findings.every(item => item.blocking !== true));
});

test('marks zoom denial as the fail-closed accessibility exception', () => {
  const report = audit([
    html('index.html', '<meta name="viewport" content="user-scalable=no">'),
  ]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.blocking, true);
  assert.equal(report.findings[0]?.id, 'viewport-user-zoom-disabled');
});
