<script lang="ts">
  /* eslint-disable svelte/no-dom-manipulating, @typescript-eslint/no-explicit-any -- pdf.js and docx-preview draw into a host element imperatively (same approach as the course document viewer) */
  import { tick, untrack } from 'svelte';
  import * as Dialog from '@cio/ui/base/dialog';
  import { Button } from '@cio/ui/base/button';
  import { Spinner } from '@cio/ui/base/spinner';
  import DownloadIcon from '@lucide/svelte/icons/download';
  import UploadIcon from '@lucide/svelte/icons/upload';
  import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
  import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
  import { profile } from '$lib/utils/store/user';
  import { resourcesLearnerApi, type LearnerResourceItem } from '../../../api/resources-learner.svelte';
  import { fmtBytes } from '../../shared/format';
  import { canPreview, fileFamily } from './resource-utils';

  // Full-screen (mobile) / large (desktop) viewer for one resource. The file is fetched ONCE per resource from the API
  // (inline stream — no storage URL ever reaches the page) and drawn client-side: PDF on pdf.js canvases (same approach
  // as the course document viewer), .docx with docx-preview. Learning resources have no download button; right-click,
  // drag, selection, copy and print are disabled and a light watermark (learner name + date) sits on top. This deters
  // casual copying; it is not DRM.

  interface Props {
    open: boolean;
    resource: LearnerResourceItem | null;
    downloading?: boolean;
    /** Learner screens can upload the completed workbook; staff viewing a learner cannot. */
    canUpload?: boolean;
    onDownload: (r: LearnerResourceItem) => void;
    onUpload: (r: LearnerResourceItem) => void;
  }
  let {
    open = $bindable(false),
    resource,
    downloading = false,
    canUpload = false,
    onDownload,
    onUpload
  }: Props = $props();

  let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let errorText = $state('');
  let host = $state<HTMLDivElement | null>(null);
  let zoom = $state(1);
  let pageInfo = $state('');

  // The last fetched file is kept so closing and reopening the same resource never asks the API again.
  let cache: { key: string; buffer: ArrayBuffer } | null = null;
  let loadToken = 0;
  let pdfjsPromise: Promise<any> | null = null;
  // The live pdf.js loading task (owns the document + worker resources); destroyed before every re-render and on close.
  let pdfTask: any = null;

  function destroyPdf() {
    const t = pdfTask;
    pdfTask = null;
    try {
      void t?.destroy();
    } catch {
      /* already destroyed */
    }
  }

  const cacheKey = (r: LearnerResourceItem) => `${r.id}:${r.version}:${r.enrolmentId}`;
  const family = $derived(resource ? fileFamily(resource) : 'other');
  const previewable = $derived(resource ? canPreview(resource) : false);

  const watermark = $derived.by(() => {
    const name = (($profile.fullname as string) || 'Learner').replace(/[<>&"']/g, '');
    const date = new Date().toLocaleDateString('en-GB');
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='340' height='220'><text x='20' y='120' fill='rgb(100,100,100)' fill-opacity='0.13' ` +
      `font-family='sans-serif' font-size='16' transform='rotate(-24 170 110)'>${name} · ${date}</text></svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  });

  function loadPdfjs(): Promise<any> {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const w = window as any;
      const ready = () => {
        w.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/pdf.js/pdf.worker.min.js';
        resolve(w.pdfjsLib);
      };
      if (w.pdfjsLib) return ready();
      const script = document.createElement('script');
      script.src = '/js/pdf.js/pdf.min.js';
      script.onload = ready;
      script.onerror = () => {
        pdfjsPromise = null;
        reject(new Error('pdf.js failed to load'));
      };
      document.head.appendChild(script);
    });
    return pdfjsPromise;
  }

  async function renderPdf(buffer: ArrayBuffer, token: number) {
    const lib = await loadPdfjs();
    // pdf.js transfers the buffer to its worker: hand it a copy so the cached one stays usable.
    destroyPdf();
    const task = lib.getDocument({ data: buffer.slice(0) });
    pdfTask = task;
    let doc: any;
    try {
      doc = await task.promise;
    } catch (e) {
      if (pdfTask === task) pdfTask = null;
      throw e;
    }
    if (token !== loadToken || !host || pdfTask !== task) {
      if (pdfTask === task) pdfTask = null;
      void task.destroy();
      return;
    }
    host.replaceChildren();
    const width = Math.max(240, host.clientWidth - 16);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    pageInfo = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (token !== loadToken || !host || pdfTask !== task) return;
      const base = page.getViewport({ scale: 1 });
      const scale = (width / base.width) * zoom;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = `${vp.width / dpr}px`;
      canvas.style.height = `${vp.height / dpr}px`;
      canvas.className = 'mx-auto mb-3 block max-w-none bg-white shadow';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Page ${n} of ${doc.numPages}`);
      host.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      if (token === loadToken && n === 1) status = 'ready';
    }
  }

  async function renderDocx(buffer: ArrayBuffer, token: number) {
    const { renderAsync } = await import('docx-preview');
    if (token !== loadToken || !host) return;
    host.replaceChildren();
    await renderAsync(buffer.slice(0), host, host, {
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: true,
      breakPages: true,
      useBase64URL: true
    });
    if (token !== loadToken) return;
    fitDocx();
    pageInfo = '';
    status = 'ready';
  }

  // Narrow screens: shrink the fixed-width Word page to fit (CSS zoom), times the learner's own zoom.
  function fitDocx() {
    const wrapper = host?.querySelector<HTMLElement>('.docx-wrapper');
    const section = host?.querySelector<HTMLElement>('section.docx');
    if (!host || !wrapper || !section) return;
    const natural = section.offsetWidth || 794;
    const fit = Math.min(1, (host.clientWidth - 16) / natural);
    wrapper.style.setProperty('zoom', String(fit * zoom));
  }

  async function show(r: LearnerResourceItem) {
    const token = ++loadToken;
    errorText = '';
    pageInfo = '';
    zoom = 1;
    if (!canPreview(r)) {
      status = 'error';
      errorText = 'This file type cannot be previewed here. Download it to open it.';
      return;
    }
    status = 'loading';
    const key = cacheKey(r);
    if (cache?.key !== key) {
      const res = await resourcesLearnerApi.content(r.id, r.enrolmentId);
      if (token !== loadToken) return;
      if (!res.ok) {
        status = 'error';
        errorText = res.error;
        return;
      }
      cache = { key, buffer: res.data };
    }
    await tick();
    try {
      if (fileFamily(r) === 'pdf') await renderPdf(cache!.buffer, token);
      else await renderDocx(cache!.buffer, token);
    } catch (e) {
      console.error('Resource render failed', e);
      if (token === loadToken) {
        status = 'error';
        errorText = 'This file could not be displayed. Please try again.';
      }
    }
  }

  let zoomTimer: ReturnType<typeof setTimeout> | null = null;

  // Unmount: stop any in-flight render and free the pdf document, rendered pages and cached buffer.
  $effect(() => () => {
    loadToken += 1;
    destroyPdf();
    if (zoomTimer) clearTimeout(zoomTimer);
    host?.replaceChildren();
    cache = null;
  });

  // Open → load once per resource (re-run only when the resource itself changes).
  $effect(() => {
    const r = resource;
    if (open && r && host) {
      untrack(() => {
        void show(r);
      });
    } else if (!open) {
      untrack(() => {
        loadToken += 1;
        destroyPdf();
        host?.replaceChildren();
        if (zoomTimer) clearTimeout(zoomTimer);
        status = 'idle';
      });
    }
  });

  function changeZoom(delta: number) {
    const next = Math.min(3, Math.max(0.5, Math.round((zoom + delta) * 100) / 100));
    if (next === zoom) return;
    zoom = next;
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      if (!resource || status === 'error' || !cache) return;
      if (family === 'pdf') {
        const token = ++loadToken;
        void renderPdf(cache.buffer, token).catch(() => {});
      } else {
        fitDocx();
      }
    }, 200);
  }

  const block = (e: Event) => e.preventDefault();
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex! h-dvh max-h-dvh w-screen max-w-none! flex-col gap-0! overflow-hidden rounded-none! p-0! sm:h-[92dvh] sm:w-[min(1100px,96vw)] sm:rounded-lg!"
  >
    <header class="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3 pe-12">
      <div class="min-w-0">
        <Dialog.Title class="truncate text-base font-semibold">{resource?.title ?? 'Resource'}</Dialog.Title>
        <Dialog.Description class="truncate text-xs text-(--muted-foreground)">
          {resource?.kind === 'WORKBOOK' ? 'Workbook' : 'View only'}
          {#if resource}· {fmtBytes(resource.file.size)}{/if}
          {#if pageInfo}· {pageInfo}{/if}
        </Dialog.Description>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {#if previewable && status === 'ready'}
          <div class="flex items-center gap-1" role="group" aria-label="Zoom">
            <Button variant="outline" size="icon" aria-label="Zoom out" onclick={() => changeZoom(-0.25)}>
              <ZoomOutIcon size={16} />
            </Button>
            <span class="w-10 text-center text-xs tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <Button variant="outline" size="icon" aria-label="Zoom in" onclick={() => changeZoom(0.25)}>
              <ZoomInIcon size={16} />
            </Button>
          </div>
        {/if}
        {#if resource?.downloadable}
          <Button variant="outline" size="sm" loading={downloading} onclick={() => resource && onDownload(resource)}>
            <DownloadIcon size={14} class="mr-1" /> Download
          </Button>
        {/if}
        {#if canUpload && resource?.kind === 'WORKBOOK'}
          <Button size="sm" onclick={() => resource && onUpload(resource)}>
            <UploadIcon size={14} class="mr-1" /> Upload completed workbook
          </Button>
        {/if}
      </div>
    </header>

    <div class="resource-viewer relative min-h-0 flex-1 bg-(--muted)/40">
      <div
        class="absolute inset-0 overflow-auto select-none"
        role="document"
        oncontextmenu={block}
        ondragstart={block}
        oncopy={block}
        oncut={block}
      >
        <div bind:this={host} class="p-2" aria-label="{resource?.title ?? 'Resource'} content"></div>
      </div>

      {#if status === 'loading'}
        <div class="absolute inset-0 flex items-center justify-center" role="status" aria-label="Loading resource">
          <Spinner />
        </div>
      {:else if status === 'error'}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p role="alert" class="max-w-md text-sm text-rose-600">{errorText}</p>
          {#if previewable && resource}
            <Button variant="outline" size="sm" onclick={() => resource && show(resource)}>Try again</Button>
          {/if}
        </div>
      {/if}

      <!-- Watermark sits over the page but never blocks scrolling or taps. -->
      <div
        class="pointer-events-none absolute inset-0 z-10"
        style="background-image: {watermark}; background-repeat: repeat;"
        aria-hidden="true"
      ></div>
    </div>
  </Dialog.Content>
</Dialog.Root>

<style>
  .resource-viewer :global(img),
  .resource-viewer :global(canvas) {
    -webkit-user-drag: none;
    user-select: none;
  }
  @media print {
    .resource-viewer {
      display: none !important;
    }
  }
</style>
