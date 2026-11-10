<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Switch } from '@cio/ui/base/switch';
  import * as Select from '@cio/ui/base/select';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import { APPR_ONBOARDING_LABEL_MAX, APPR_ONBOARDING_TYPES_MAX } from '@cio/utils/constants/apprenticeship';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi } from '../../api/programmes.svelte';
  import { apprOnboardingApi, type OnboardingTypeInput, type OnboardingTypeRow } from '../../api/onboarding.svelte';

  // Apprenticeships › Settings › Onboarding documents: what each apprentice is asked to upload at the start (photo ID,
  // NI proof…). Hide a type with "Requested" off; a type that already has uploads cannot be deleted, only hidden.

  let types = $state<OnboardingTypeRow[] | null>(null);
  let loadError = $state<string | null>(null);
  let busyId = $state<string | null>(null);
  let adding = $state(false);
  let newLabel = $state('');
  // Unsaved text edits keyed by type id.
  let labelDraft = $state<Record<string, string>>({});
  let descDraft = $state<Record<string, string>>({});

  onMount(() => {
    load();
    programmesApi.load();
  });

  async function load() {
    const res = await apprOnboardingApi.listTypes();
    if (res.ok) {
      types = res.data;
      loadError = null;
    } else {
      loadError = res.error;
    }
  }

  const programmes = $derived(programmesApi.programmes ?? []);
  const scopeLabel = (programmeId: string | null) =>
    programmeId ? (programmes.find((p) => p.id === programmeId)?.title ?? 'One programme') : 'All programmes';

  /** Apply a server row to the list in place (keeps unsaved drafts on other rows). */
  function applyRow(row: OnboardingTypeRow) {
    types = (types ?? []).map((t) => (t.id === row.id ? { ...t, ...row } : t));
  }

  async function patch(t: OnboardingTypeRow, json: Partial<OnboardingTypeInput>) {
    busyId = t.id;
    const res = await apprOnboardingApi.updateType(t.id, json);
    busyId = null;
    if (!res.ok) {
      snackbar.error(res.error);
      return false;
    }
    applyRow({ ...res.data, inUse: t.inUse });
    return true;
  }

  async function saveLabel(t: OnboardingTypeRow) {
    const label = (labelDraft[t.id] ?? t.label).trim();
    delete labelDraft[t.id];
    if (!label || label === t.label) return;
    await patch(t, { label });
  }

  async function saveDescription(t: OnboardingTypeRow) {
    if (descDraft[t.id] === undefined) return;
    const description = descDraft[t.id].trim() || null;
    delete descDraft[t.id];
    if (description === (t.description ?? null)) return;
    await patch(t, { description });
  }

  async function move(index: number, dir: -1 | 1) {
    if (!types) return;
    const next = [...types];
    const [item] = next.splice(index, 1);
    next.splice(index + dir, 0, item);
    busyId = item.id;
    const res = await apprOnboardingApi.reorderTypes(next.map((t) => t.id));
    busyId = null;
    if (res.ok) types = res.data;
    else snackbar.error(res.error);
  }

  async function remove(t: OnboardingTypeRow) {
    busyId = t.id;
    const res = await apprOnboardingApi.deleteType(t.id);
    busyId = null;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    types = (types ?? []).filter((x) => x.id !== t.id);
  }

  async function addType(e: Event) {
    e.preventDefault();
    const label = newLabel.trim();
    if (!label || adding) return;
    adding = true;
    const res = await apprOnboardingApi.createType({ label });
    adding = false;
    if (!res.ok) {
      snackbar.error(res.error);
      return;
    }
    newLabel = '';
    types = [...(types ?? []), { ...res.data, inUse: false }];
  }
</script>

<div class="flex flex-col gap-4 rounded-xl border bg-(--card) p-4">
  <div>
    <h2 class="text-lg font-semibold tracking-tight">Onboarding documents</h2>
    <p class="text-sm text-(--muted-foreground)">
      What each apprentice is asked to upload when they start. Turn "Requested" off to stop asking for a type; types
      that already have uploads can be hidden but not deleted.
    </p>
  </div>

  {#if loadError && !types}
    <div class="flex flex-col items-center gap-3 py-8" role="alert">
      <p class="text-sm text-red-600">{loadError}</p>
      <Button variant="outline" onclick={load}>Try again</Button>
    </div>
  {:else if !types}
    <div class="flex justify-center py-8"><Spinner /></div>
  {:else}
    <ul class="flex flex-col gap-3">
      {#each types as t, i (t.id)}
        <li class="space-y-3 rounded-lg border p-3 {t.active ? '' : 'opacity-70'}">
          <div class="flex items-center gap-2">
            <Input
              aria-label="Document name"
              value={labelDraft[t.id] ?? t.label}
              maxlength={APPR_ONBOARDING_LABEL_MAX}
              oninput={(e) => (labelDraft[t.id] = e.currentTarget.value)}
              onblur={() => saveLabel(t)}
              onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
              disabled={busyId === t.id}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Move {t.label} up"
              disabled={i === 0 || busyId === t.id}
              onclick={() => move(i, -1)}
            >
              <ArrowUpIcon class="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Move {t.label} down"
              disabled={i === types.length - 1 || busyId === t.id}
              onclick={() => move(i, 1)}
            >
              <ArrowDownIcon class="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t.inUse ? `${t.label} is in use — turn Requested off instead` : `Delete ${t.label}`}
              title={t.inUse ? 'In use — deactivate it instead' : 'Delete'}
              disabled={t.inUse || busyId === t.id}
              onclick={() => remove(t)}
            >
              <Trash2Icon class="size-4" />
            </Button>
          </div>

          <Input
            aria-label="Help text for {t.label}"
            placeholder="Help text shown to the learner (optional)"
            value={descDraft[t.id] ?? t.description ?? ''}
            maxlength={1000}
            oninput={(e) => (descDraft[t.id] = e.currentTarget.value)}
            onblur={() => saveDescription(t)}
            onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            disabled={busyId === t.id}
          />

          <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <label class="flex items-center gap-2">
              <Switch
                checked={t.active}
                disabled={busyId === t.id}
                aria-label="Requested: {t.label}"
                onCheckedChange={(v) => patch(t, { active: v })}
              />
              Requested
            </label>
            <label class="flex items-center gap-2">
              <Switch
                checked={t.required}
                disabled={busyId === t.id}
                aria-label="Required: {t.label}"
                onCheckedChange={(v) => patch(t, { required: v })}
              />
              Required
            </label>
            <label class="flex items-center gap-2">
              <Switch
                checked={t.allowNotHeld}
                disabled={busyId === t.id}
                aria-label="Allow I don't have this: {t.label}"
                onCheckedChange={(v) => patch(t, { allowNotHeld: v })}
              />
              Allow "I don't have this"
            </label>
            <div class="flex items-center gap-2">
              <span id="ob-scope-{t.id}" class="text-(--muted-foreground)">Applies to</span>
              <Select.Root
                type="single"
                value={t.programmeId ?? 'all'}
                disabled={busyId === t.id}
                onValueChange={(v) => patch(t, { programmeId: v === 'all' ? null : v })}
              >
                <Select.Trigger class="min-w-[180px]" aria-labelledby="ob-scope-{t.id}">
                  {scopeLabel(t.programmeId)}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="all">All programmes</Select.Item>
                  {#each programmes as p (p.id)}
                    <Select.Item value={p.id}>{p.title}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
            </div>
          </div>
        </li>
      {:else}
        <li class="text-sm text-(--muted-foreground)">No document types yet.</li>
      {/each}
    </ul>

    <form onsubmit={addType} class="flex items-end gap-2">
      <div class="flex-1 space-y-1">
        <label for="ob-new-type" class="text-sm font-medium">Add a document</label>
        <Input
          id="ob-new-type"
          bind:value={newLabel}
          maxlength={APPR_ONBOARDING_LABEL_MAX}
          placeholder="e.g. Proof of address"
        />
      </div>
      <Button type="submit" disabled={!newLabel.trim() || types.length >= APPR_ONBOARDING_TYPES_MAX} loading={adding}>
        <PlusIcon class="size-4" /> Add
      </Button>
    </form>
  {/if}
</div>
