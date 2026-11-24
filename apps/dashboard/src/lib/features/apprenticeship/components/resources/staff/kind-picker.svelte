<script lang="ts">
  import * as RadioGroup from '@cio/ui/base/radio-group';
  import type { ApprResourceKind } from '@cio/utils/constants/apprenticeship';

  // Two big radio cards explaining what each kind means for learners.
  interface Props {
    value: ApprResourceKind;
    idPrefix?: string;
    disabled?: boolean;
  }
  let { value = $bindable(), idPrefix = 'rk', disabled = false }: Props = $props();

  const OPTIONS: { value: ApprResourceKind; title: string; text: string }[] = [
    {
      value: 'LEARNING',
      title: 'Learning resource · view only',
      text: 'Learners read it in the browser and cannot download it. PDF or Word (.docx).'
    },
    {
      value: 'WORKBOOK',
      title: 'Workbook · downloadable',
      text: 'Learners download it, fill it in and upload the completed copy as evidence. PDF, Word, Excel or PowerPoint.'
    }
  ];
</script>

<fieldset class="space-y-2">
  <legend class="text-sm font-medium">Type of resource</legend>
  <RadioGroup.Root bind:value class="grid gap-2 sm:grid-cols-2" {disabled}>
    {#each OPTIONS as o (o.value)}
      <label
        for="{idPrefix}-{o.value}"
        class="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm {value === o.value
          ? 'border-(--primary) bg-(--primary)/5'
          : 'hover:bg-(--muted)/40'}"
      >
        <RadioGroup.Item value={o.value} id="{idPrefix}-{o.value}" class="mt-0.5" />
        <span>
          <span class="block font-medium">{o.title}</span>
          <span class="block text-xs text-(--muted-foreground)">{o.text}</span>
        </span>
      </label>
    {/each}
  </RadioGroup.Root>
</fieldset>
