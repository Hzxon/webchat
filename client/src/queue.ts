/**
 * Runs the jobs that share a key one at a time, in the order they were queued. A job starts once
 * the one before it has settled, so a failure never holds up the jobs behind it (D-075).
 */
export function keyedQueue() {
  const tails = new Map<unknown, Promise<unknown>>();
  return <T>(key: unknown, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job);
    tails.set(key, run.catch(() => undefined));
    return run;
  };
}
