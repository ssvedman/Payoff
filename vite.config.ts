import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Project site at https://<user>.github.io/Payoff/, so built assets must be
 * requested from /Payoff/.
 *
 * Key this off `mode`, not `command`. `vite preview` reports command === 'serve'
 * exactly as the dev server does, so keying off command gives preview base '/'
 * while the HTML it serves references '/Payoff/' — every asset then falls through
 * to the SPA fallback and returns index.html as text/html, and the page renders
 * blank with no console error.
 *
 *   vite          -> mode development -> base /         (dev server)
 *   vite build    -> mode production  -> base /Payoff/  (what Pages serves)
 *   vite preview  -> mode production  -> base /Payoff/  (faithful rehearsal)
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'production' ? '/Payoff/' : '/',
}))
