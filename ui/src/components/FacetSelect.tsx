import { createEffect, For, on } from 'solid-js'

/** One value a filter can be narrowed to, with how often it occurs. */
export type FacetOption = { value: string; label: string }

/**
 * One dropdown of a filter row: a placeholder that clears the field, then the
 * values the window holds, the chosen one darkening the field. Shared by the
 * Marending request filters and the acta source filter, which differ only in
 * what they count.
 */
export default function FacetSelect(props: {
  /** The field's name, also the placeholder: "method", "source". */
  label: string
  options: FacetOption[]
  /** The chosen value, '' for "not filtered". */
  value: string
  onChange: (value: string) => void
}) {
  // A value chosen in an earlier window can be gone from this one. Keeping it in
  // the list is what lets the field still show — and still undo — the narrowing
  // it applies.
  const options = () => {
    if (props.value === '' || props.options.some((option) => option.value === props.value)) {
      return props.options
    }
    return [{ value: props.value, label: props.value }, ...props.options]
  }

  return (
    <select
      class="filter"
      classList={{ set: props.value !== '' }}
      aria-label={props.label}
      ref={(element) => {
        // Options are reconciled in this same flush, and assigning a value the
        // select does not hold yet falls back to the first option. Setting it
        // once the flush is over is what keeps the chosen field showing after a
        // range change replaces the values.
        createEffect(
          on(
            () => [props.options, props.value] as const,
            () => queueMicrotask(() => (element.value = props.value)),
          ),
        )
      }}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <option value="">{props.label}</option>
      <For each={options()}>
        {(option) => <option value={option.value}>{option.label}</option>}
      </For>
    </select>
  )
}
