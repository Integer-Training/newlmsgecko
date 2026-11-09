<script lang="ts">
  // One bar, two values: the filled part is the ACTUAL position, the tick is where the learner SHOULD be today.
  // Both come straight from the API (never recomputed here). Fixed height so rows never shift.
  interface Props {
    actual: number | null;
    expected?: number | null;
    label?: string;
    class?: string;
  }
  let { actual, expected = null, label = 'Progress', class: className = '' }: Props = $props();

  const a = $derived(Math.max(0, Math.min(100, actual ?? 0)));
  const e = $derived(expected === null ? null : Math.max(0, Math.min(100, expected)));
</script>

<!-- Colours via the theme variables: the dashboard's own Tailwind build has no unprefixed theme colour utilities
     (muted / primary / foreground), so those classes rendered nothing (an invisible bar). -->
<div
  class="relative h-2 w-full rounded-full {className}"
  style="background-color: var(--muted)"
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={actual ?? 0}
  aria-valuetext={`${actual ?? 0}%${e !== null ? `, expected ${e}%` : ''}`}
>
  <div class="h-full rounded-full transition-all" style="width: {a}%; background-color: var(--primary)"></div>
  {#if e !== null}
    <div
      class="absolute -top-0.5 h-3 w-0.5 rounded"
      style="left: calc({e}% - 1px); background-color: var(--foreground)"
      title="Expected {e}%"
    ></div>
  {/if}
</div>
