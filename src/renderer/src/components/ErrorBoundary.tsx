import { Component, type ErrorInfo, type ReactNode } from 'react';
import { PixelButton } from './PixelButton';
import { reportRendererError } from '../rendererErrors';

/**
 * HISTORY-SCROLL-FREEZE F3: one panel's render error no longer takes the whole app down.
 *
 * React 18 unmounts the ENTIRE root on an error no boundary catches. Before 1.1.80 the renderer
 * had no boundary at all, so a loop in the History tab blanked the window while main and the
 * agents kept running. A boundary shows what failed in place of its children, reports it
 * (a `renderer-error` row in log.jsonl), and offers a way back: 'remount' tries the children
 * again, 'reload' reloads the window (the root boundary, where nothing else is left to show).
 */
export interface ErrorBoundaryProps {
  /** What is shown here, for the message and the log row: 'History', 'The app'. */
  where: string;
  recover?: 'remount' | 'reload';
  children: ReactNode;
}

interface State { error: Error | null }

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRendererError({
      source: 'boundary',
      where: this.props.where,
      message: error?.message || String(error),
      stack: error?.stack,
      componentStack: info?.componentStack ?? undefined
    });
  }

  private readonly recover = (): void => {
    if (this.props.recover === 'reload') {
      // Jim B1: through main (recovery notice first), never location.reload(): a bare reload lands
      // on the HivePicker, whose switch path tears down the live agents.
      (window as unknown as { cth?: { reloadAfterError?: (where: string) => void } }).cth?.reloadAfterError?.(this.props.where);
      return;
    }
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" data-error-boundary={this.props.where} style={{
        padding: 16, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start',
        fontSize: 13, color: 'var(--cth-ink-900)', background: 'var(--cth-paper-100)'
      }}>
        <div>{this.props.recover === 'reload'
          ? `${this.props.where} hit an error and stopped drawing. The agents keep running.`
          : `${this.props.where} could not be shown. The rest of the app is unaffected.`}</div>
        <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', overflowWrap: 'anywhere' }}>
          {error.message || String(error)}
        </div>
        <PixelButton variant="secondary" size="sm" onClick={this.recover}>
          {this.props.recover === 'reload' ? 'Reload the window' : 'Try again'}
        </PixelButton>
      </div>
    );
  }
}
