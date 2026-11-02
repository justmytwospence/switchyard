import { Component, type ErrorInfo, type ReactNode } from "react";
import { FatalError } from "./states";

interface Props {
  children: ReactNode;
  /** Custom fallback; defaults to FatalError with a diagnostics link. */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
}

interface State {
  error: unknown;
}

/** Catches render errors in a view so the shell and navigation keep working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("View crashed", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error !== null) {
      return this.props.fallback ? (
        this.props.fallback(this.state.error, this.reset)
      ) : (
        <FatalError error={this.state.error} />
      );
    }
    return this.props.children;
  }
}
