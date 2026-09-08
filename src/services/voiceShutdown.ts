/** Start transport cleanup independently from database/reporting work. */
export async function runCallCleanup(tasks: Array<() => Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Call cleanup failed");
}

/** Share duplicate close requests; permit a later retry if transport cleanup fails. */
export function createCallDisconnect(disconnect: () => Promise<unknown>) {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(disconnect).then(() => undefined).catch((error) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
