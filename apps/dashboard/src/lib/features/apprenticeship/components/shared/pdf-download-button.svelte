<script lang="ts">
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import { snackbar } from '$features/ui/snackbar/store';
  import { reportApi } from '../../api/report.svelte';

  // "Download PDF" for one enrolment's portfolio: fetches the report payload and builds the PDF in the browser
  // (jsPDF is loaded only on click).
  let { enrolmentId }: { enrolmentId: string } = $props();
  let busy = $state(false);

  async function download() {
    busy = true;
    try {
      const res = await reportApi.get(enrolmentId);
      if (!res.ok) {
        snackbar.error(res.error);
        return;
      }
      const { downloadPortfolioPdf } = await import('../../utils/portfolio-pdf');
      await downloadPortfolioPdf(res.data);
    } catch (error) {
      console.error('Error generating portfolio PDF:', error);
      snackbar.error('Could not generate the PDF.');
    } finally {
      busy = false;
    }
  }
</script>

<Button variant="outline" size="sm" disabled={busy} onclick={download}>
  {#if busy}<Spinner class="mr-1 size-4" />{/if}
  Download PDF
</Button>
