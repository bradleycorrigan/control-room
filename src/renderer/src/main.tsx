import './assets/base.css'
import './theme/tokens.css'
import './styles.css'
import './components/app-shell.css'
import './screens/project-rail.css'
import './screens/projects-list.css'
import './screens/project-detail.css'
import './screens/modals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

// Anything that slips past a screen's own catch still reaches the app's log,
// with what it was, instead of vanishing into a devtools nobody has open.
window.addEventListener('error', (e) => {
  void window.api.invoke('log:rendererError', {
    screen: document.querySelector('.main-pane')?.getAttribute('data-screen') ?? 'unknown',
    message: e.message,
    stack: e.error instanceof Error ? e.error.stack?.split('\n').slice(0, 8).join('\n') : undefined
  })
})
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason))
  void window.api.invoke('log:rendererError', {
    screen: document.querySelector('.main-pane')?.getAttribute('data-screen') ?? 'unknown',
    message: `unhandled promise: ${err.message}`,
    stack: err.stack?.split('\n').slice(0, 8).join('\n')
  })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
