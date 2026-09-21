import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AdminRouteBoundaryProps {
  readonly children: ReactNode;
}

interface AdminRouteBoundaryState {
  readonly failed: boolean;
}

export class AdminRouteBoundary extends Component<
  AdminRouteBoundaryProps,
  AdminRouteBoundaryState
> {
  public state: AdminRouteBoundaryState = {
    failed: false,
  };

  public static getDerivedStateFromError(): AdminRouteBoundaryState {
    return { failed: true };
  }

  public componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally no remote telemetry or console leak. A failed lazy chunk is
    // surfaced locally and the user can request a clean reload.
  }

  public render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <div className="alert alert-danger my-3" role="alert">
        <p className="mb-2">
          Yönetim modülü yüklenemedi. Ağ bağlantınızı kontrol edip tekrar deneyin.
        </p>
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={() => window.location.reload()}
        >
          Sayfayı yeniden yükle
        </button>
      </div>
    );
  }
}
