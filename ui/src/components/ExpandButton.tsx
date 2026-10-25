import { toggleFullscreen } from '../lib/fullscreen'

/**
 * The `v` shortcut as a tap target: a phone has no keyboard and no hover, so
 * every tile that can be maximized carries its own button. `App.css` keeps it
 * hidden above the single-column layout, where the corner is better left quiet.
 */
export default function ExpandButton(props: { tile: string }) {
  return (
    <button
      class="tile-expand"
      aria-label="Fullscreen"
      title="Fullscreen"
      onClick={() => toggleFullscreen(props.tile)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M9.5 3H13v3.5M13 3 9.5 6.5M6.5 13H3V9.5M3 13l3.5-3.5" />
      </svg>
    </button>
  )
}
