<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Textarea } from '@cio/ui/base/textarea';
  import { APPR_LEVELS, APPR_PROGRAMME_TYPE_LABELS, type ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
  import { currentOrg } from '$lib/utils/store/org';
  import { programmesApi, type PairCandidate } from '$features/apprenticeship/api/programmes.svelte';

  // Create a programme in two steps: pick the type, then fill in the details (a diploma can be paired with a
  // standard straight away). Creating also makes its first qualification server-side; then open its setup page.
  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  const NONE = '__none__';
  const TYPES: ApprProgrammeType[] = ['DIPLOMA', 'STANDARD'];
  const TYPE_INFO: Record<ApprProgrammeType, string> = {
    DIPLOMA: 'The qualification learners work towards, with graded units and criteria (for example an NCFE diploma).',
    STANDARD:
      'The apprenticeship standard itself: knowledge, skills and behaviours that are signed off alongside one or more diplomas.'
  };

  let step = $state<1 | 2>(1);
  let type = $state<ApprProgrammeType>('DIPLOMA');
  let title = $state('');
  let reference = $state('');
  let awardingBody = $state('');
  let level = $state('3');
  let description = $state('');
  let pairedId = $state(NONE);
  let standards = $state<PairCandidate[]>([]);
  let loadingStandards = $state(false);
  let saving = $state(false);

  const canSubmit = $derived(!!title.trim() && !saving);
  const levelStandards = $derived(standards.filter((s) => (s.level ?? '').match(/\d/)?.[0] === level));
  const pairedLabel = $derived(levelStandards.find((s) => s.id === pairedId)?.title ?? 'No paired standard');

  function reset() {
    step = 1;
    type = 'DIPLOMA';
    title = '';
    reference = '';
    awardingBody = '';
    level = '3';
    description = '';
    pairedId = NONE;
  }

  async function chooseType(t: ApprProgrammeType) {
    type = t;
    step = 2;
    if (t === 'DIPLOMA') {
      loadingStandards = true;
      standards = (await programmesApi.loadActiveStandards())
        .filter((p) => p.type === 'STANDARD')
        .map((p) => ({ id: p.id, title: p.title, level: p.level }));
      loadingStandards = false;
    }
  }

  // A pairing must match the level; drop a stale pick if the level changes.
  $effect(() => {
    if (pairedId !== NONE && !levelStandards.some((s) => s.id === pairedId)) pairedId = NONE;
  });

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit) return;
    saving = true;
    const created = await programmesApi.create({
      title: title.trim(),
      reference: reference.trim() || null,
      awardingBody: awardingBody.trim() || null,
      level,
      description: description.trim() || null,
      type,
      ...(type === 'DIPLOMA' && pairedId !== NONE ? { pairedProgrammeId: pairedId } : {})
    });
    saving = false;
    if (!created) return;
    open = false;
    reset();
    goto(`/org/${$currentOrg.siteName}/apprenticeships/programmes/${created.id}`);
  }
</script>

<Dialog.Root bind:open onOpenChange={(next) => !next && reset()}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>New programme</Dialog.Title>
      <Dialog.Description>
        {step === 1
          ? 'What are you setting up?'
          : `${APPR_PROGRAMME_TYPE_LABELS[type]}. You add its units and criteria on the next screen.`}
      </Dialog.Description>
    </Dialog.Header>

    {#if step === 1}
      <div class="flex flex-col gap-3" role="group" aria-label="Programme type">
        {#each TYPES as t (t)}
          <button
            type="button"
            class="flex flex-col gap-1 rounded-xl border p-4 text-left hover:border-(--primary) hover:bg-(--muted)"
            onclick={() => chooseType(t)}
          >
            <span class="font-semibold">{APPR_PROGRAMME_TYPE_LABELS[t]}</span>
            <span class="text-sm text-(--muted-foreground)">{TYPE_INFO[t]}</span>
          </button>
        {/each}
      </div>
      <Dialog.Footer class="mt-2">
        <Button type="button" variant="outline" onclick={() => (open = false)}>Cancel</Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={submit} class="flex flex-col gap-3">
        <div class="space-y-1">
          <label for="np-title" class="text-sm font-medium">Title <span class="text-red-500">*</span></label>
          <Input
            id="np-title"
            bind:value={title}
            maxlength={200}
            placeholder={type === 'STANDARD' ? 'Business Administrator standard' : 'Level 3 Business Administrator'}
            required
          />
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="np-ref" class="text-sm font-medium">Reference</label>
            <Input id="np-ref" bind:value={reference} maxlength={100} placeholder="ST0070" />
          </div>
          <div class="space-y-1">
            <span id="np-level-label" class="text-sm font-medium">Level</span>
            <Select.Root type="single" bind:value={level}>
              <Select.Trigger class="w-full" aria-labelledby="np-level-label">
                <p>Level {level}</p>
              </Select.Trigger>
              <Select.Content>
                {#each APPR_LEVELS as l (l)}
                  <Select.Item value={String(l)}>Level {l}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </div>
        <div class="space-y-1">
          <label for="np-body" class="text-sm font-medium">Awarding body</label>
          <Input id="np-body" bind:value={awardingBody} maxlength={200} placeholder="NCFE" />
        </div>
        {#if type === 'DIPLOMA'}
          <div class="space-y-1">
            <span id="np-pair-label" class="text-sm font-medium">Pair with standard (optional)</span>
            <Select.Root type="single" bind:value={pairedId} disabled={loadingStandards}>
              <Select.Trigger class="w-full" aria-labelledby="np-pair-label">
                <p>{loadingStandards ? 'Loading…' : pairedLabel}</p>
              </Select.Trigger>
              <Select.Content>
                <Select.Item value={NONE}>No paired standard</Select.Item>
                {#each levelStandards as s (s.id)}
                  <Select.Item value={s.id}>{s.title}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <p class="text-xs text-(--muted-foreground)">
              Only active standards at Level {level}. You can pair later from the programme page.
            </p>
          </div>
        {/if}
        <div class="space-y-1">
          <label for="np-desc" class="text-sm font-medium">Description</label>
          <Textarea id="np-desc" bind:value={description} rows={3} maxlength={5000} />
        </div>

        <Dialog.Footer class="mt-2">
          <Button type="button" variant="outline" onclick={() => (step = 1)}>Back</Button>
          <Button type="submit" disabled={!canSubmit} loading={saving}>Create programme</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
