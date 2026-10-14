import type { Component } from 'solid-js'

import Home from './Home'

export type Dashboard = {
  id: string
  title: string
  component: Component
}

export const DASHBOARDS: Dashboard[] = [{ id: 'home', title: 'Home', component: Home }]
