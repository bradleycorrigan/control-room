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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
