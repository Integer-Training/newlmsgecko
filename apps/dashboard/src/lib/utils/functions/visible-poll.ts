/**
 * Runs `fn` every `ms` while the tab is visible. Paused while document.hidden; on becoming visible again it
 * refreshes once and resumes. Returns a cleanup function (clears the timer and the listener).
 */
export function startVisiblePoll(fn: () => void, ms: number): () => void {
  if (typeof document === 'undefined') return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (!timer) timer = setInterval(fn, ms);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => {
    if (document.hidden) {
      stop();
    } else {
      fn();
      start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
