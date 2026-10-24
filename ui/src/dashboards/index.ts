import { lazy, type Component } from 'solid-js'

import Home from './Home'
import Marending from './Marending'

// Lazy: pulls MapLibre (and its worker) into a separate chunk, loaded only when
// the Location dashboard is opened.
const Location = lazy(() => import('./Location'))

export type Dashboard = {
  id: string
  title: string
  component: Component
}

export const DASHBOARDS: Dashboard[] = [
  { id: 'home', title: 'Home', component: Home },
  { id: 'marending', title: 'Marending', component: Marending },
  { id: 'location', title: 'Location', component: Location },
]
