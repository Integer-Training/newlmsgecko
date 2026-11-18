<script lang="ts">
  import * as Dialog from '@cio/ui/base/dialog';
  import * as Select from '@cio/ui/base/select';
  import { Button } from '@cio/ui/base/button';
  import { Input } from '@cio/ui/base/input';
  import { learnerManagementApi } from '$features/learner-management/api/learner-management.svelte';
  import RevealPanel from './reveal-panel.svelte';
  import { enrolmentsApi } from '$features/apprenticeship/api/enrolments.svelte';
  import type { LearnerCheckResult } from '$features/apprenticeship/api/overview.types';

  // Create-learner dialog. First/last name + email + course + tutor are all REQUIRED — a learner is always
  // enrolled in a course and assigned a tutor. On success the dialog switches to a reveal panel showing the
  // temporary password.

  interface Props {
    open: boolean;
  }

  let { open = $bindable() }: Props = $props();

  let firstName = $state('');
  let lastName = $state('');
  let email = $state('');
  let courseId = $state('');
  let tutorId = $state('');

  // Phase 6: when the email already has an account, look up (admin-only, after the 409) whether that person is an
  // apprentice. Both choices are non-blocking: warn only, or use a different email for a separate profile.
  let conflictCheck = $state<LearnerCheckResult | null>(null);
  let keepAccountNote = $state(false);

  $effect(() => {
    if (!learnerManagementApi.emailConflict) {
      conflictCheck = null;
      keepAccountNote = false;
      return;
    }
    const addr = email.trim();
    enrolmentsApi.learnerCheck({ email: addr }).then((res) => {
      if (res.ok && learnerManagementApi.emailConflict && addr === email.trim()) conflictCheck = res.data;
    });
  });

  function useDifferentEmail() {
    email = '';
    learnerManagementApi.clearConflict();
    document.getElementById('nl-email')?.focus();
  }

  const hasCourses = $derived(learnerManagementApi.options.courses.length > 0);
  const hasTutors = $derived(learnerManagementApi.options.tutors.length > 0);

  const canSubmit = $derived(
    !!firstName.trim() &&
      !!lastName.trim() &&
      !!email.trim() &&
      !!courseId &&
      !!tutorId &&
      !learnerManagementApi.creating
  );

  const courseLabel = $derived(
    courseId
      ? (learnerManagementApi.options.courses.find((c) => c.courseId === courseId)?.title ?? 'Course')
      : 'Select a course'
  );
  const tutorLabel = $derived(
    tutorId ? (learnerManagementApi.options.tutors.find((t) => t.id === tutorId)?.name ?? 'Tutor') : 'Select a tutor'
  );

  function resetForm() {
    firstName = '';
    lastName = '';
    email = '';
    courseId = '';
    tutorId = '';
    keepAccountNote = false;
    learnerManagementApi.clearConflict();
  }

  async function submit() {
    if (!canSubmit) return;
    await learnerManagementApi.createLearner({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      courseId,
      tutorId
    });
  }

  function done() {
    open = false;
  }

  // When the dialog closes (via Done, overlay, or escape) clear the reveal + form so the next open starts fresh.
  function onOpenChange(next: boolean) {
    if (!next) {
      learnerManagementApi.clearRevealed();
      resetForm();
    }
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    {#if learnerManagementApi.revealed}
      <Dialog.Header>
        <Dialog.Title>Learner created</Dialog.Title>
      </Dialog.Header>

      <RevealPanel name={learnerManagementApi.revealed.name} password={learnerManagementApi.revealed.password} />

      <Dialog.Footer class="mt-4">
        <Button onclick={done}>Done</Button>
      </Dialog.Footer>
    {:else}
      <Dialog.Header>
        <Dialog.Title>New learner</Dialog.Title>
        <Dialog.Description>Create a learner account and reveal a temporary password.</Dialog.Description>
      </Dialog.Header>

      <div class="flex flex-col gap-3">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="nl-first" class="text-sm font-medium">First name</label>
            <Input id="nl-first" bind:value={firstName} placeholder="Jane" maxlength={100} />
          </div>
          <div class="space-y-1">
            <label for="nl-last" class="text-sm font-medium">Last name</label>
            <Input id="nl-last" bind:value={lastName} placeholder="Doe" maxlength={100} />
          </div>
        </div>

        <div class="space-y-1">
          <label for="nl-email" class="text-sm font-medium">Email</label>
          <Input
            id="nl-email"
            type="email"
            bind:value={email}
            placeholder="jane@example.com"
            autocomplete="off"
            oninput={() => learnerManagementApi.clearConflict()}
          />
        </div>

        {#if learnerManagementApi.emailConflict}
          <div
            class="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            aria-live="polite"
          >
            <p>A person with this email already has an account.</p>
            {#if conflictCheck && conflictCheck.apprenticeship.length > 0}
              <p>
                Already an apprentice on
                <strong>{[...new Set(conflictCheck.apprenticeship.map((a) => a.programmeTitle))].join(', ')}</strong>.
                Apprenticeship records are kept separate from their courses.
              </p>
            {/if}
            {#if keepAccountNote}
              <p>
                To enrol this existing account on a course, open the course and add them from its People tab. No new
                account has been created.
              </p>
            {/if}
            <div class="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onclick={() => (keepAccountNote = true)}>
                Continue with this account
              </Button>
              <Button type="button" size="sm" variant="outline" onclick={useDifferentEmail}>
                Use a different email for a separate profile
              </Button>
            </div>
          </div>
        {/if}

        <div class="space-y-1">
          <label for="nl-course" class="text-sm font-medium">Course <span class="text-red-500">*</span></label>
          <Select.Root type="single" bind:value={courseId}>
            <Select.Trigger id="nl-course" class="ui:w-full">{courseLabel}</Select.Trigger>
            <Select.Content>
              {#each learnerManagementApi.options.courses as course (course.courseId)}
                <Select.Item value={course.courseId}>{course.title ?? 'Untitled course'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if !hasCourses}
            <p class="text-xs text-red-500">Create a published course first — a learner must be enrolled in one.</p>
          {/if}
        </div>

        <div class="space-y-1">
          <label for="nl-tutor" class="text-sm font-medium">Tutor <span class="text-red-500">*</span></label>
          <Select.Root type="single" bind:value={tutorId}>
            <Select.Trigger id="nl-tutor" class="ui:w-full">{tutorLabel}</Select.Trigger>
            <Select.Content>
              {#each learnerManagementApi.options.tutors as tutor (tutor.id)}
                <Select.Item value={tutor.id}>{tutor.name ?? tutor.email ?? 'Tutor'}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if !hasTutors}
            <p class="text-xs text-red-500">Create a tutor first — a learner must be assigned to one.</p>
          {/if}
        </div>
      </div>

      <Dialog.Footer class="mt-4">
        <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
        <Button onclick={submit} loading={learnerManagementApi.creating} disabled={!canSubmit}>Create learner</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
