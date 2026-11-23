<script lang="ts">
  import ProgrammeTypeChip from './programme-type-chip.svelte';

  // Type chip + programme name (truncated, full name on hover) + optional "×n criteria". One line.
  interface Props {
    type?: string | null;
    title: string;
    count?: number | null;
    class?: string;
  }
  let { type = null, title, count = null, class: className = '' }: Props = $props();
</script>

<span class="inline-flex max-w-full min-w-0 items-center gap-1.5 {className}" {title}>
  {#if type}<ProgrammeTypeChip {type} />{/if}
  <span class="min-w-0 truncate text-xs">{title}</span>
  {#if count != null}<span class="shrink-0 text-xs text-(--muted-foreground)">×{count}</span>{/if}
</span>
