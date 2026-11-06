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

<div
  class="bg-muted relative h-2 w-full rounded-full {className}"
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={actual ?? 0}
  aria-valuetext={`${actual ?? 0}%${e !== null ? `, expected ${e}%` : ''}`}
>
  <div class="bg-primary h-full rounded-full transition-all" style="width: {a}%"></div>
  {#if e !== null}
    <div
      class="bg-foreground absolute -top-0.5 h-3 w-0.5 rounded"
      style="left: calc({e}% - 1px)"
      title="Expected {e}%"
    ></div>
  {/if}
</div>
