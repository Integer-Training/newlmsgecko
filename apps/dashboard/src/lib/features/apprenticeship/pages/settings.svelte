<script lang="ts">
  import { onMount } from 'svelte';
  import * as Page from '@cio/ui/base/page';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { Spinner } from '@cio/ui/base/spinner';
  import { Switch } from '@cio/ui/base/switch';
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
  import PlusIcon from '@lucide/svelte/icons/plus';
  import { currentOrg } from '$lib/utils/store/org';
  import { snackbar } from '$features/ui/snackbar/store';
  import { programmesApi, type EvidenceType } from '$features/apprenticeship/api/programmes.svelte';
  import OnboardingTypesSettings from '$features/apprenticeship/components/onboarding/onboarding-types-settings.svelte';

  // Org rules for Gecko Apprenticeships: progress thresholds, off-the-job (OTJ) hours, and the evidence-type list.
  // Status is computed on read, so saving the thresholds needs no recalculation.
  let concernGapPct = $state(15);
  let otjPercent = $state(20);
  let weeklyCap = $state(30);
  let saving = $state(false);
  let newLabel = $state('');
  let adding = $state(false);
  let busyId = $state<string | null>(null);
  // Unsaved label edits keyed by evidence type id.
  let labelDraft = $state<Record<string, string>>({});

  onMount(async () => {
    await programmesApi.loadSettings();
  });

  // Seed the form once the settings arrive.
  // Only when the saved values change, so evidence-type edits (which reload) do not wipe unsaved typing.
  let seeded = '';
  $effect(() => {
    const s = programmesApi.settings;
    if (!s) return;
    const key = `${s.concernGapPct}|${s.otjFactor}|${s.otjWeeklyCapHours}`;
    if (key === seeded) return;
    seeded = key;
    concernGapPct = s.concernGapPct;
    otjPercent = Math.round(s.otjFactor * 100);
    weeklyCap = s.otjWeeklyCapHours;
  });

  const gapValid = $derived(Number.isInteger(concernGapPct) && concernGapPct >= 0 && concernGapPct <= 100);
  const otjValid = $derived(Number.isFinite(otjPercent) && otjPercent >= 0 && otjPercent <= 100);
  const capValid = $derived(Number.isFinite(weeklyCap) && weeklyCap >= 1 && weeklyCap <= 60);
  const dirty = $derived(
    !!programmesApi.settings &&
      (concernGapPct !== programmesApi.settings.concernGapPct ||
        otjPercent !== Math.round(programmesApi.settings.otjFactor * 100) ||
        weeklyCap !== programmesApi.settings.otjWeeklyCapHours)
  );

  async function save(e: Event) {
    e.preventDefault();
    if (!gapValid || !otjValid || !capValid || saving) return;
    saving = true;
    const ok = await programmesApi.saveSettings({
      concernGapPct,
      otjFactor: otjPercent / 100,
      otjWeeklyCapHours: weeklyCap
    });
    saving = false;
    if (ok) snackbar.success('Settings saved');
  }

  async function renameType(t: EvidenceType) {
    const label = (labelDraft[t.id] ?? t.label).trim();
    if (!label || label === t.label) {
      delete labelDraft[t.id];
      return;
    }
    busyId = t.id;
    const ok = await programmesApi.patchEvidenceType(t.id, { label });
    if (ok) await programmesApi.loadSettings();
    delete labelDraft[t.id];
    busyId = null;
  }

  async function toggleActive(t: EvidenceType, active: boolean) {
    busyId = t.id;
    const ok = await programmesApi.patchEvidenceType(t.id, { active });
    if (ok) await programmesApi.loadSettings();
    busyId = null;
  }

  async function move(t: EvidenceType, dir: -1 | 1) {
    busyId = t.id;
    await programmesApi.moveEvidenceType(t.id, dir);
    busyId = null;
  }

  async function addType(e: Event) {
    e.preventDefault();
    const label = newLabel.trim();
    if (!label || adding) return;
    adding = true;
    const ok = await programmesApi.addEvidenceType(label);
    adding = false;
    if (ok) newLabel = '';
  }

  const types = $derived(programmesApi.evidenceTypes ?? []);
</script>

<svelte:head><title>Apprenticeship settings — Gecko Apprenticeships</title></svelte:head>

<Page.Root class="w-full">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>Apprenticeship settings</Page.Title>
      <Page.Subtitle>Progress rules, evidence types and onboarding documents · {$currentOrg.name}</Page.Subtitle>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      {#if programmesApi.loadError && !programmesApi.settings}
        <div class="flex flex-col items-center gap-3 py-16" role="alert">
          <p class="text-sm text-red-600">{programmesApi.loadError}</p>
          <Button variant="outline" onclick={() => programmesApi.loadSettings()}>Try again</Button>
        </div>
      {:else if !programmesApi.settings}
        <div class="flex justify-center py-16"><Spinner /></div>
      {:else}
        <div class="grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-2">
          <!-- Thresholds -->
          <form onsubmit={save} class="flex flex-col gap-4 rounded-xl border bg-(--card) p-4">
            <div>
              <h2 class="text-lg font-semibold tracking-tight">Progress rules</h2>
              <p class="text-sm text-(--muted-foreground)">
                How a learner is flagged compared with where they should be by now.
              </p>
            </div>

            <div class="space-y-1">
              <label for="s-gap" class="text-sm font-medium">Concern gap (percentage points)</label>
              <Input id="s-gap" type="number" min={0} max={100} step={1} bind:value={concernGapPct} class="max-w-32" />
              <p class="text-xs text-(--muted-foreground)">
                Behind = below the expected progress by up to {Number.isFinite(concernGapPct) ? concernGapPct : '…'} points.
                Concern = more than {Number.isFinite(concernGapPct) ? concernGapPct : '…'} points below.
              </p>
              {#if !gapValid}<p class="text-xs text-red-600" role="alert">Enter a whole number from 0 to 100.</p>{/if}
            </div>

            <div class="space-y-1">
              <label for="s-otj" class="text-sm font-medium">Off-the-job factor (%)</label>
              <Input id="s-otj" type="number" min={0} max={100} step={1} bind:value={otjPercent} class="max-w-32" />
              <p class="text-xs text-(--muted-foreground)">
                Share of working hours that must be off-the-job training. 20 means a learner on 30 working hours a week
                needs 6 off-the-job hours a week.
              </p>
              {#if !otjValid}<p class="text-xs text-red-600" role="alert">Enter a number from 0 to 100.</p>{/if}
            </div>

            <div class="space-y-1">
              <label for="s-cap" class="text-sm font-medium">Weekly hours cap</label>
              <Input id="s-cap" type="number" min={1} max={60} step={0.5} bind:value={weeklyCap} class="max-w-32" />
              <p class="text-xs text-(--muted-foreground)">
                The most working hours counted in one week when working out the off-the-job target.
              </p>
              {#if !capValid}<p class="text-xs text-red-600" role="alert">Enter a number from 1 to 60.</p>{/if}
            </div>

            <div>
              <Button type="submit" disabled={!dirty || !gapValid || !otjValid || !capValid} loading={saving}>
                Save rules
              </Button>
            </div>
          </form>

          <!-- Evidence types -->
          <div class="flex flex-col gap-4 rounded-xl border bg-(--card) p-4">
            <div>
              <h2 class="text-lg font-semibold tracking-tight">Evidence types</h2>
              <p class="text-sm text-(--muted-foreground)">
                What learners can label their evidence as. Hidden types stay on existing evidence but cannot be chosen
                for new evidence.
              </p>
            </div>

            <ul class="flex flex-col gap-2">
              {#each types as t, i (t.id)}
                <li class="flex items-center gap-2">
                  <Input
                    aria-label="Evidence type name"
                    value={labelDraft[t.id] ?? t.label}
                    maxlength={100}
                    class={t.active ? '' : 'opacity-60'}
                    oninput={(e) => (labelDraft[t.id] = e.currentTarget.value)}
                    onblur={() => renameType(t)}
                    onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                    disabled={busyId === t.id}
                  />
                  <div class="flex items-center gap-1">
                    <Switch
                      checked={t.active}
                      aria-label="{t.active ? 'Hide' : 'Show'} {t.label}"
                      disabled={busyId === t.id}
                      onCheckedChange={(v) => toggleActive(t, v)}
                    />
                    <span class="w-12 text-xs text-(--muted-foreground)">{t.active ? 'Shown' : 'Hidden'}</span>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move {t.label} up"
                    disabled={i === 0 || busyId === t.id}
                    onclick={() => move(t, -1)}
                  >
                    <ArrowUpIcon class="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Move {t.label} down"
                    disabled={i === types.length - 1 || busyId === t.id}
                    onclick={() => move(t, 1)}
                  >
                    <ArrowDownIcon class="size-4" />
                  </Button>
                </li>
              {:else}
                <li class="text-(--muted-foreground) text-sm">No evidence types yet.</li>
              {/each}
            </ul>

            <form onsubmit={addType} class="flex items-end gap-2">
              <div class="flex-1 space-y-1">
                <label for="s-new-type" class="text-sm font-medium">Add an evidence type</label>
                <Input id="s-new-type" bind:value={newLabel} maxlength={100} placeholder="e.g. Reflective account" />
              </div>
              <Button type="submit" disabled={!newLabel.trim()} loading={adding}>
                <PlusIcon class="size-4" /> Add
              </Button>
            </form>
          </div>

          <div class="lg:col-span-2">
            <OnboardingTypesSettings />
          </div>
        </div>
      {/if}
    {/snippet}
  </Page.Body>
</Page.Root>
