// The active page can fail independently of its rows. The shell keys this boundary by page so
// the sidebar and its navigation stay usable and opening another page clears the failure.
import { Component, type ErrorInfo, type ReactNode } from 'react';

export class PageBoundary extends Component<
  { readonly message: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[shell] active page failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? (
      <p className="error-text" role="alert">
        {this.props.message}
      </p>
    ) : (
      this.props.children
    );
  }
}
