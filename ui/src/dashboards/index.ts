import { lazy, type Component } from 'solid-js'

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
}

export const DASHBOARDS: Dashboard[] = [
  { id: 'home', title: 'home', component: Home },
  { id: 'eos', title: 'eos', component: Eos },
  { id: 'marending', title: 'marending', component: Marending },
  { id: 'location', title: 'location', component: Location },
]
