import {
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  type QueryKey,
} from "@tanstack/react-query"

// Exclude currentUser so LanguageSwitch does not race with a stale /users/me refetch before PATCH completes.
const isRefreshedOnLocaleChange = (query: Query) =>
  query.queryKey[0] !== "currentUser"

const isPlanningQuery = (query: Query) =>
  query.queryKey[0] === "capacity" && query.queryKey[2] === "planning"

const clientReadOnlyQueries = new WeakMap<QueryClient, WeakSet<object>>()

/** Returns whether the active fetch for a planning query was triggered solely by a locale refresh. */
export function isLocaleReadOnlyPlanningQuery(
  queryClient: QueryClient,
  queryKey: QueryKey,
): boolean {
  const readOnlyQueries = clientReadOnlyQueries.get(queryClient)
  if (!readOnlyQueries) return false
  const query = queryClient.getQueryCache().find({ queryKey, exact: true })
  return query !== undefined && readOnlyQueries.has(query)
}

/** Build a QueryClient whose active queries refresh immediately on locale change, without replaying or starting snapshot writes. */
export function createLocaleQueryClient(onError: (error: Error) => void): {
  queryClient: QueryClient
  refreshForLocaleChange: () => void
} {
  const staleInFlightQueries = new WeakSet<object>()
  const readOnlyPlanningQueries = new WeakSet<object>()
  const rearmingReadOnly = new WeakSet<object>()
  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError,
      onSuccess: (_data, query) => {
        if (staleInFlightQueries.delete(query)) {
          // Wait for the in-flight snapshot write/fetch to commit before running a read-only GET in the new locale.
          readOnlyPlanningQueries.add(query)
          rearmingReadOnly.add(query)
          void queryClient.invalidateQueries({
            queryKey: query.queryKey,
            exact: true,
          })
        }
      },
      onSettled: (_data, error, query) => {
        if (error !== null) staleInFlightQueries.delete(query)
        // Skip clearing onSettled for the just-finished in-flight fetch when onSuccess immediately re-armed readOnly for the follow-up GET.
        if (rearmingReadOnly.delete(query)) return
        readOnlyPlanningQueries.delete(query)
      },
    }),
    mutationCache: new MutationCache({
      onError,
    }),
  })
  clientReadOnlyQueries.set(queryClient, readOnlyPlanningQueries)

  const refreshForLocaleChange = () => {
    for (const query of queryClient.getQueryCache().getAll()) {
      if (!isRefreshedOnLocaleChange(query)) continue
      if (isPlanningQuery(query)) {
        if (query.state.fetchStatus === "fetching") {
          staleInFlightQueries.add(query)
        } else if (query.state.data !== undefined) {
          // Already-loaded planning snapshots must only re-read localized fields on language switch, never create a new snapshot.
          readOnlyPlanningQueries.add(query)
        }
        continue
      }
      if (
        query.state.fetchStatus === "fetching" &&
        query.state.data === undefined &&
        query.isActive() &&
        !query.isDisabled() &&
        !query.isStatic()
      ) {
        // TanStack Query's refetchQueries only cancels when data !== undefined; cancel silently so invalidateQueries starts a fresh request immediately.
        void query.cancel({ silent: true })
      }
    }
    void queryClient.invalidateQueries({
      predicate: (query) =>
        isRefreshedOnLocaleChange(query) && !staleInFlightQueries.has(query),
    })
  }

  return { queryClient, refreshForLocaleChange }
}
