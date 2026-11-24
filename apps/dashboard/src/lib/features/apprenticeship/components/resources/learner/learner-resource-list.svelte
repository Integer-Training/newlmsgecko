<script lang="ts">
  import ProgrammeTypeChip from '../../shared/programme-type-chip.svelte';
  import type { ProgrammeSection } from './resource-utils';
  import type { ResourceActions } from './resource-actions.svelte';
  import ResourceRow from './resource-row.svelte';

  // Resources grouped Programme (Diploma / Standard chip + title) -> General -> units. Programme headings only appear
  // when there is more than one programme to tell apart (a paired apprentice sees both, labelled).

  interface Props {
    sections: ProgrammeSection[];
    actions: ResourceActions;
    mode?: 'learner' | 'staff';
    uploadBlocked?: boolean;
    uploadBlockedReason?: string;
  }
  let { sections, actions, mode = 'learner', uploadBlocked = false, uploadBlockedReason }: Props = $props();
</script>

<div class="space-y-6">
  {#each sections as s (s.enrolmentId)}
    <section class="space-y-3" aria-label={s.title}>
      {#if sections.length > 1 || s.withdrawn}
        <div class="flex flex-wrap items-center gap-2">
          {#if s.type}<ProgrammeTypeChip type={s.type} />{/if}
          <h2 class="text-base font-semibold">{s.title}</h2>
          {#if s.withdrawn}
            <span
              class="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-500/20 dark:text-rose-300"
            >
              Withdrawn
            </span>
          {/if}
        </div>
      {/if}
      {#each s.groups as g (g.unitId ?? 'general')}
        <div class="overflow-hidden rounded-lg border bg-(--card)">
          <h3 class="border-b bg-(--muted)/40 px-3 py-2 text-sm font-semibold">{g.label}</h3>
          <ul class="divide-y">
            {#each g.items as r (r.id + r.enrolmentId)}
              <ResourceRow resource={r} {actions} {mode} {uploadBlocked} {uploadBlockedReason} />
            {/each}
          </ul>
        </div>
      {/each}
    </section>
  {/each}
</div>
