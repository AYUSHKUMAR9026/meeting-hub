'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ApiResult<T> = { data?: T; error?: unknown; response: Response };

export type QueryState<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: unknown; httpStatus: number };

/**
 * Loads data with the typed API client and tracks loading / success / error.
 * Re-runs when `key` changes or `reload()` is called; stale responses are ignored.
 */
export function useApiQuery<T>(key: string, load: () => Promise<ApiResult<T>>) {
  const [state, setState] = useState<QueryState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    let active = true;
    loadRef
      .current()
      .then(({ data, error, response }) => {
        if (!active) return;
        setState(
          data !== undefined
            ? { status: 'ok', data }
            : { status: 'error', error, httpStatus: response.status },
        );
      })
      .catch((error: unknown) => {
        if (active) setState({ status: 'error', error, httpStatus: 0 });
      });
    return () => {
      active = false;
    };
  }, [key, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { state, reload };
}
