import ReactDOM from 'react-dom/client'
import '@fontsource/im-fell-english/400.css'
import '@fontsource/im-fell-english/400-italic.css'
import '@fontsource/im-fell-english-sc/400.css'
import './styles.css'
import App from './App'

// StrictMode is deliberately omitted: the drafting engine is imperative and
// double-mounting restarts the plot ceremony on boot.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
