import { lazy, type Component } from 'solid-js'

import Acta from './Acta'
import Eos from './Eos'
import Home from './Home'
import Marending from './Marending'

// Lazy: pulls MapLibre (and its worker) into a separate chunk, loaded only when
// the Location dashboard is opened.
const Location = lazy(() => import('./Location'))

export type Dashboard = {
  id: string
  title: string
  component: Component
  /** Whether a restricted viewer (`scope: home`) may open it. Presentation
   *  only: what such a viewer can *read* is decided by the service. */
  shared?: boolean
}

export const DASHBOARDS: Dashboard[] = [
  { id: 'home', title: 'home', component: Home, shared: true },
  { id: 'acta', title: 'acta', component: Acta },
  { id: 'eos', title: 'eos', component: Eos },
  { id: 'marending', title: 'marending', component: Marending },
  { id: 'location', title: 'location', component: Location },
]
