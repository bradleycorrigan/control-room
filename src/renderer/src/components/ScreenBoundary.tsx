import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './primitives'

/**
 * Catches a crash in the screen it wraps: the rest of the app keeps working,
 * the screen says what happened with a way back, and the error goes to the
 * app's log with the screen's name, instead of a blank or frozen pane.
 * `resetKey` changes as you move between screens, which clears it.
 */
export default class ScreenBoundary extends Component<
  { screen: string; resetKey: string; children: ReactNode },
  { error: Error | null; key: string }
> {
  state = { error: null as Error | null, key: this.props.resetKey }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; key: string }
  ): { error: Error | null; key: string } | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.api.invoke('log:rendererError', {
      screen: this.props.screen,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 8).join('\n'),
      component: info.componentStack?.split('\n').slice(0, 6).join('\n')
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="screen-boundary" role="alert">
        <h2>This screen hit an error</h2>
        <p>
          The rest of the app is fine. Reload the screen to carry on; the details are in the log.
        </p>
        <p className="screen-boundary-detail">{this.state.error.message}</p>
        <Button variant="filled" onClick={() => this.setState({ error: null })}>
          Reload screen
        </Button>
      </div>
    )
  }
}
