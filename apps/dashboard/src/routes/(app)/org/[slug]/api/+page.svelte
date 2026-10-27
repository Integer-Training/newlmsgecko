<script lang="ts">
  import { ApiAutomationPage } from '$features/automation/pages';
  import { automationApi } from '$features/automation/api/automation.svelte';
  import { t } from '$lib/utils/functions/translations';
  import * as Page from '@cio/ui/base/page';

  let { data } = $props();

  $effect(() => {
    if (!data) return;
    automationApi.keys = data.keys;
    automationApi.isFetched = true;
  });
</script>

<svelte:head>
  <title>{t.get('automation.tabs.api')} - Gecko Programmes</title>
</svelte:head>

<Page.Root class="mx-auto w-full max-w-4xl">
  <Page.Header>
    <Page.HeaderContent>
      <Page.Title>{$t('automation.tabs.api')}</Page.Title>
      <Page.Subtitle>{$t('automation.api.subtitle')}</Page.Subtitle>
    </Page.HeaderContent>
  </Page.Header>

  <Page.Body>
    {#snippet child()}
      <ApiAutomationPage />
    {/snippet}
  </Page.Body>
</Page.Root>
