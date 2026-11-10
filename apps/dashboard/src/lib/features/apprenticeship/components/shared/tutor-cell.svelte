<script lang="ts">
  import { tutorNames, type TutorsInput } from '../../api/enrolments.svelte';

  // The tutor(s) of a row: the learner's named tutor(s), else the programme's tutor(s) labelled "(programme)", else an
  // amber "No tutor" chip. The rule itself is the API's; this only displays what it sends.
  interface Props {
    tutors: TutorsInput;
  }
  let { tutors }: Props = $props();

  const text = $derived(tutorNames(tutors));
</script>

{#if text === '—'}
  <span
    class="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
  >
    No tutor
  </span>
{:else}
  <span class="text-sm">{text}</span>
{/if}
