<script lang="ts">
  import WorkspaceLayout from '$features/apprenticeship/components/shell/workspace-layout.svelte';
  import { tutorWorkspaceTabs } from '$features/apprenticeship/utils/paths';

  let { children } = $props();

  const tabs = tutorWorkspaceTabs('/caseload/apprenticeships');
</script>

<WorkspaceLayout {tabs}>
  {@render children?.()}
</WorkspaceLayout>
