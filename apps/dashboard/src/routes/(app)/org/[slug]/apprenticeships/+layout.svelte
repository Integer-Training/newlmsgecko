<script lang="ts">
  import { page } from '$app/state';
  import WorkspaceLayout from '$features/apprenticeship/components/shell/workspace-layout.svelte';
  import { adminWorkspaceTabs, apprenticeshipsBase } from '$features/apprenticeship/utils/paths';

  let { children } = $props();

  const base = $derived(apprenticeshipsBase(page.url.pathname, page.params.slug));
  const tabs = $derived(adminWorkspaceTabs(base));
</script>

<!-- "Enrol apprentice" goes to the Learners tab, where the Enrol apprentice dialog opens. -->
<WorkspaceLayout {tabs} enrolHref="{base}?enrol=1">
  {@render children?.()}
</WorkspaceLayout>
