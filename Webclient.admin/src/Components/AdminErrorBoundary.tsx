import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportAdminError } from "../platform/diagnostics";

export interface AdminErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AdminErrorBoundaryState {
  readonly error: Error | null;
}

export class AdminErrorBoundary extends Component<
  AdminErrorBoundaryProps,
  AdminErrorBoundaryState
> {
  state: AdminErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportAdminError("ui", "react-boundary", error, {
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="container py-5" role="alert">
        <h1>Yönetim paneli yüklenemedi</h1>
        <p>
          Beklenmeyen bir arayüz hatası oluştu. Güvenli biçimde yeniden yükleyip
          tekrar deneyebilirsiniz.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Sayfayı yeniden yükle
        </button>
      </main>
    );
  }
}
