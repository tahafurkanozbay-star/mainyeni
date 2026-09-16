import { Component, type ErrorInfo, type ReactNode } from 'react';
import { runtimeDiagnostics } from './runtimeDiagnostics';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
  readonly incidentId: number | null;
}

const createUnknownError = (value: unknown): Error => (
  value instanceof Error ? value : new Error(String(value ?? 'Unknown application error'))
);

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    incidentId: null,
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const normalized = createUnknownError(error);
    return {
      error: normalized,
      incidentId: null,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const event = runtimeDiagnostics.captureError(error, {
      source: 'react.error-boundary',
      componentStack: info.componentStack || null,
    }, 'fatal');
    this.setState({ incidentId: event.id });
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, incidentId } = this.state;
    if (!error) return this.props.children;

    return (
      <main
        role="alert"
        aria-live="assertive"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: '#f7f7f7',
          color: '#1f2937',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <section style={{ maxWidth: 640, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.75rem' }}>
            Uygulama beklenmeyen bir hatayla karşılaştı
          </h1>
          <p style={{ lineHeight: 1.6, marginBottom: '1rem' }}>
            Harita oturumu güvenli biçimde durduruldu. Sayfayı yenileyerek yeni bir oturum başlatabilirsiniz.
          </p>
          {incidentId !== null && (
            <p style={{ fontSize: '0.875rem', opacity: 0.72 }}>
              Olay kimliği: {incidentId}
            </p>
          )}
          <button
            type="button"
            onClick={this.reload}
            style={{
              marginTop: '1rem',
              padding: '0.75rem 1.1rem',
              borderRadius: 8,
              border: '1px solid currentColor',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Sayfayı yenile
          </button>
        </section>
      </main>
    );
  }
}
