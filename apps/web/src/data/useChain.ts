/**
 * Polling, and the states a read can be in.
 *
 * Four states, not three. `loading`, `ready`, `error`, and `unreachable`. An RPC that cannot be
 * reached is separated from one that answered with an error, for the same reason the settlement
 * monitor separates `NotObserved` from `Absent`: a network problem shown as an empty result is
 * a page telling somebody an incident does not exist when it does.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ReadState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T; at: number }
  | { status: "unreachable"; message: string }
  | { status: "error"; message: string };

/**
 * Runs a read, then re-runs it on an interval.
 *
 * The refresh is deliberate rather than reactive. Chain state changes without telling the
 * browser, and a page that only fetched once would show a settled incident as pending until
 * somebody reloaded.
 */
export function usePolled<T>(
  read: () => Promise<T>,
  deps: readonly unknown[],
  intervalMs = 4_000,
): { state: ReadState<T>; refresh: () => void } {
  const [state, setState] = useState<ReadState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async (): Promise<void> => {
      try {
        const value = await read();
        if (alive.current) setState({ status: "ready", value, at: Date.now() });
      } catch (error) {
        if (!alive.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // A fetch that never reached a server and one that came back with a program error are
        // different problems with different fixes, and the page says which.
        const unreachable =
          message.includes("fetch") ||
          message.includes("Failed to fetch") ||
          message.includes("ECONNREFUSED") ||
          message.includes("NetworkError");
        setState(unreachable ? { status: "unreachable", message } : { status: "error", message });
      }
      if (alive.current && intervalMs > 0) timer = setTimeout(run, intervalMs);
    };

    void run();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, intervalMs]);

  return { state, refresh };
}
