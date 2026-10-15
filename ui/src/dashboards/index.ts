import { lazy, type Component } from 'solid-js'

import Heuried from './Heuried'
import Home from './Home'

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
  { id: 'heuried', title: 'Heuried', component: Heuried },
  { id: 'location', title: 'Location', component: Location },
]
