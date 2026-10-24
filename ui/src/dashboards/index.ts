import { lazy, type Component } from 'solid-js'

import Home from './Home'
import Website from './Website'

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
  { id: 'website', title: 'Website', component: Website },
  { id: 'location', title: 'Location', component: Location },
]
