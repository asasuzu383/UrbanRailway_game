/** 最後の呼び出しから delayMs 経ってから fn を実行する。flush() で即時実行、cancel() で破棄。 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };
  const call = (...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
  call.flush = () => {
    if (timer) clearTimeout(timer);
    run();
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return call;
}
