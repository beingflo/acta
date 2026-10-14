/* @refresh reload */
import { render } from 'solid-js/web'
import './index.css'
import App from './App.tsx'
import { applyRangeFromUrl, canonicalizePath } from './lib/url'

// Load the date range from the URL and normalize the path before first render.
applyRangeFromUrl()
canonicalizePath()

const root = document.getElementById('root')

render(() => <App />, root!)
