/** A promise that settles after `ms`, with a timer that cannot hold the process open. */
export const asyncWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Settle with `promise`, or reject with `message` once `ms` has passed.
 *
 * The original promise keeps running; a rejection it produces after the
 * timeout is swallowed rather than reported as unhandled.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
