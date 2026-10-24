import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** When this changes (the person navigated), a previous failure is forgotten. */
  resetKey?: string;
}
interface State {
  failed: boolean;
}

/**
 * Catches a screen that crashed or could not load its code (most often: the
 * connection dropped just as the person tapped to a screen they hadn't opened
 * yet). Without this React shows a blank page with no explanation.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return (
      <div role="alert" className="mx-auto flex min-h-[60vh] max-w-md flex-col items-start justify-center gap-4 px-6">
        <h1 className="text-3xl font-semibold">{offline ? "No connection" : "We couldn't load this page"}</h1>
        <p className="text-lg text-muted-foreground">
          {offline
            ? "You're offline right now. Check your internet connection, then try again. Nothing you've already saved has been lost."
            : "Something went wrong on our side while opening this page. Please try again. If it keeps happening, ask for help."}
        </p>
        <Button size="lg" onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  }
}
