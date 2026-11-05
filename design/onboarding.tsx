// Design preview of the first-open setup. It runs the same component the app shows, with no backend needed.
import {createRoot} from 'react-dom/client'
import Onboarding from '../src/onboarding/Onboarding'
import {loadTheme} from '../src/theme'

const theme = loadTheme()
document.documentElement.dataset.theme = theme
createRoot(document.getElementById('root')!).render(<Onboarding theme={theme} onDone={() => location.reload()}/>)
