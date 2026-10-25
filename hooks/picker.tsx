import type { Elements, RenderElement, RenderSurface, Timer, UiOpenResult } from 'claude-code'

export type PickerEntry = { name: string; kind: string }
export type AccountRow = PickerEntry & { email: string; tier: string; selected: boolean }
export type PickerControls = { invalidate: () => void; log: (text: string) => void; close: () => Promise<void>; after: (ms: number, fn: () => void) => Timer; surface?: string }
type PickerState = {
  entries?: PickerEntry[]
  entriesStatus: 'idle' | 'loading' | 'ready' | 'error'
  entriesError?: string
  rows: Map<string, AccountRow>
  rowError?: string
  loadingRows: boolean
  selecting: boolean
  selectionError?: string
  pageStart: number
  pageSize: number
  selectedName: string
  query: string
  inputValue: string
  searchTimer?: Timer
  revision: number
  invalidate: () => void
}
type LoadEntries = () => Promise<PickerEntry[]>
type LoadRows = (entries: readonly PickerEntry[]) => Promise<AccountRow[]>

export const ACCOUNT_PICKER_ID = 'rice-account-picker'
export const ACCOUNT_PICKER_PAGE_SIZE = 50
export const ACCOUNT_PICKER_MAX_PAGE_SIZE = 200
export const ACCOUNT_PICKER_SELECT_MAX_OPTIONS = 64
let activeState: PickerState | undefined
let selectionInProgress = false

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function filteredEntries(state: PickerState): PickerEntry[] {
  const entries = state.entries ?? []
  const query = state.query.trim().toLowerCase()
  return query ? entries.filter(entry => entry.name.toLowerCase().includes(query)) : entries
}

function stateFor(invalidate: () => void, selectedName: string): PickerState {
  activeState ??= {
    entriesStatus: 'idle', rows: new Map(), loadingRows: false, selecting: selectionInProgress,
    pageStart: 0, pageSize: ACCOUNT_PICKER_PAGE_SIZE, selectedName, query: '', inputValue: '', revision: 0, invalidate,
  }
  activeState.invalidate = invalidate
  const selectionChanged = activeState.selectedName !== selectedName
  activeState.selectedName = selectedName
  if (selectionChanged && activeState.entriesStatus === 'ready') {
    activeState.pageSize = ACCOUNT_PICKER_PAGE_SIZE
    positionSelectedAccount(activeState, filteredEntries(activeState))
    retainVisibleRows(activeState)
    activeState.revision += 1
    activeState.loadingRows = false
    activeState.rowError = undefined
  }
  return activeState
}

function positionSelectedAccount(state: PickerState, entries: readonly PickerEntry[]): void {
  const selectedIndex = entries.findIndex(entry => entry.name === state.selectedName)
  const lastStart = Math.max(0, entries.length - state.pageSize)
  if (selectedIndex < 0) {
    state.pageStart = Math.min(state.pageStart, lastStart)
    return
  }
  const centeredStart = Math.max(0, selectedIndex - Math.floor((state.pageSize - 1) / 2))
  state.pageStart = Math.min(centeredStart, lastStart)
}

function retainVisibleRows(state: PickerState): void {
  const visible = new Set(filteredEntries(state).slice(state.pageStart, state.pageStart + state.pageSize).map(entry => entry.name))
  for (const name of state.rows.keys()) if (!visible.has(name)) state.rows.delete(name)
}

function resetEntryWindow(state: PickerState): void {
  state.entries = undefined
  state.entriesStatus = 'idle'
  state.entriesError = undefined
  state.pageStart = 0
  state.pageSize = ACCOUNT_PICKER_PAGE_SIZE
  state.rows.clear()
  state.loadingRows = false
  state.rowError = undefined
  state.revision += 1
}

function boundPageToSurface(state: PickerState, pageMaximum: number): void {
  if (state.pageSize <= pageMaximum) return
  state.pageSize = pageMaximum
  if (state.entries) positionSelectedAccount(state, filteredEntries(state))
  else state.pageStart = 0
  state.rows.clear()
  state.rowError = undefined
  state.loadingRows = false
  if (state.entriesStatus === 'loading') {
    state.entries = undefined
    state.entriesStatus = 'idle'
  }
  state.revision += 1
}

function loadEntries(state: PickerState, entries: LoadEntries, rows: LoadRows): void {
  if (state.selecting || state.entriesStatus !== 'idle') return
  state.entriesStatus = 'loading'
  const revision = state.revision
  void entries().then(result => {
    if (activeState !== state || revision !== state.revision) return
    state.entries = result
    positionSelectedAccount(state, filteredEntries(state))
    state.entriesStatus = 'ready'
    loadVisibleRows(state, rows)
    state.invalidate()
  }).catch(error => {
    if (activeState !== state || revision !== state.revision) return
    state.entriesError = message(error)
    state.entriesStatus = 'error'
    state.invalidate()
  })
}

function loadVisibleRows(state: PickerState, rows: LoadRows): void {
  if (state.selecting || state.entriesStatus !== 'ready' || state.loadingRows || state.rowError || !state.entries) return
  const visible = filteredEntries(state).slice(state.pageStart, state.pageStart + state.pageSize)
  const missing = visible.filter(entry => !state.rows.has(entry.name))
  if (missing.length === 0) return
  state.loadingRows = true
  const revision = state.revision
  void rows(missing).then(result => {
    if (activeState !== state || revision !== state.revision) return
    if (result.length !== missing.length) throw new Error('Saved accounts changed while the picker was loading. Retry to refresh the list.')
    for (const row of result) state.rows.set(row.name, row)
    state.loadingRows = false
    state.invalidate()
  }).catch(error => {
    if (activeState !== state || revision !== state.revision) return
    state.loadingRows = false
    state.rowError = message(error)
    state.invalidate()
  })
}


export function refreshAccountPicker(): void {
  activeState?.invalidate()
}

export function resetAccountPicker(): void {
  activeState?.searchTimer?.cancel()
  activeState = undefined
}

function label(row: AccountRow): string {
  return `${row.selected ? '* ' : ''}${row.name} | ${row.email || 'email unavailable'} | ${row.tier || 'tier unavailable'}${row.selected ? ' | current session' : ''}`
}

/** Opens a native picker when this session has a surface that places panes. */
export async function openAccountPicker(open: () => Promise<UiOpenResult>): Promise<boolean> {
  resetAccountPicker()
  try {
    const opened = await open()
    if (!opened.isPlaced) resetAccountPicker()
    return opened.isPlaced
  } catch (error) {
    resetAccountPicker()
    throw error
  }
}

/** The switch callback succeeds with its status text, or throws to keep the picker open. */
export async function renderAccountPicker(
  elements: Elements[RenderSurface],
  entries: LoadEntries,
  rows: LoadRows,
  selectedName: string,
  select: (name: string) => Promise<string>,
  controls: PickerControls,
): Promise<RenderElement> {
  const { Box, Text, Button } = elements
  // The mobile app draws no Select; the element table alone cannot be trusted to say so on every host.
  const Select = controls.surface === 'mobile' ? undefined : 'Select' in elements ? elements.Select : undefined
  const pageMaximum = Select ? ACCOUNT_PICKER_SELECT_MAX_OPTIONS : ACCOUNT_PICKER_MAX_PAGE_SIZE
  const Input = 'Input' in elements ? elements.Input : undefined
  const state = stateFor(controls.invalidate, selectedName)
  boundPageToSurface(state, pageMaximum)
  loadEntries(state, entries, rows)
  if (state.entriesStatus === 'ready') loadVisibleRows(state, rows)

  const allEntries = state.entries ?? []
  const accountEntries = filteredEntries(state)
  const pageEntries = accountEntries.slice(state.pageStart, state.pageStart + state.pageSize)
  const accounts = pageEntries.map(entry => state.rows.get(entry.name) ?? {
    ...entry, email: 'Loading account details', tier: '', selected: entry.name === selectedName,
  }).map(row => ({ ...row, selected: row.name === selectedName }))
  const selectedAccount = accounts.find(row => row.selected)
  const selectionFilteredOut = Boolean(state.query) && !accountEntries.some(entry => entry.name === selectedName)
  const selectionNotVisible = !selectedAccount && (Boolean(state.query) || accountEntries.length > 0)
  const pageEnd = state.pageStart + pageEntries.length
  const hasMore = pageEnd < accountEntries.length
  const canLoadMore = !state.rowError && hasMore
  const canLoadPrevious = !state.rowError && state.pageStart > 0
  const loadMoreCount = state.pageSize < pageMaximum
    ? Math.min(ACCOUNT_PICKER_PAGE_SIZE, pageMaximum - state.pageSize)
    : ACCOUNT_PICKER_PAGE_SIZE

  const choose = async (name: string): Promise<void> => {
    if (selectionInProgress || state.selecting) return
    selectionInProgress = true
    state.selecting = true
    state.selectionError = undefined
    controls.invalidate()
    try {
      const result = await select(name)
      if (result) controls.log(result)
      if (activeState === state) {
        resetAccountPicker()
        await controls.close()
      }
    } catch (caught) {
      if (activeState === state) state.selectionError = message(caught)
    } finally {
      selectionInProgress = false
      if (activeState?.selecting) {
        activeState.selecting = false
        activeState.invalidate()
      }
    }
  }

  const applySearch = (value: string): void => {
    state.searchTimer?.cancel()
    state.searchTimer = undefined
    state.inputValue = value
    if (state.query === value) return
    state.query = value
    resetEntryWindow(state)
    state.invalidate()
  }

  const search = (value: string): void => {
    if (state.selecting) return
    state.inputValue = value
    state.searchTimer?.cancel()
    state.searchTimer = controls.after(250, () => {
      state.searchTimer = undefined
      if (activeState === state && !state.selecting) applySearch(value)
    })
  }

  const submitSearch = (value: string): void => {
    if (state.selecting) return
    applySearch(value)
  }

  const flushSearch = (): boolean => {
    if (!state.searchTimer) return false
    state.searchTimer.cancel()
    state.searchTimer = undefined
    applySearch(state.inputValue)
    return true
  }

  const loadMore = (): void => {
    if (state.searchTimer) { flushSearch(); return }
    if (state.selecting || state.loadingRows || state.rowError || !canLoadMore) return
    if (state.pageSize < pageMaximum) {
      state.pageSize = Math.min(pageMaximum, state.pageSize + ACCOUNT_PICKER_PAGE_SIZE)
    } else {
      state.pageStart += pageMaximum
      state.pageSize = ACCOUNT_PICKER_PAGE_SIZE
      state.rows.clear()
      state.rowError = undefined
    }
    state.revision += 1
    state.invalidate()
  }

  const previous = (): void => {
    if (state.searchTimer) { flushSearch(); return }
    if (state.selecting || state.loadingRows || state.rowError || !canLoadPrevious) return
    state.pageStart = Math.max(0, state.pageStart - pageMaximum)
    state.pageSize = pageMaximum
    state.rows.clear()
    state.rowError = undefined
    state.revision += 1
    state.invalidate()
  }

  const retry = (): void => {
    if (state.selecting || state.loadingRows) return
    resetEntryWindow(state)
    state.invalidate()
  }

  const error = state.selectionError ?? state.entriesError ?? state.rowError
  const pageLabel = state.entriesStatus === 'ready' && accountEntries.length > 0
    ? `Showing ${state.pageStart + 1}-${pageEnd} of ${accountEntries.length} saved accounts.`
    : undefined

  return (
    <Box flexDirection="column">
      <Text>Choose an account for this session</Text>
      <Text dimColor>Other sessions keep their accounts. Escape closes this list.</Text>
      {Input && state.entriesStatus === 'ready' && (
        <Input
          key="account-picker-search"
          label="Search accounts"
          placeholder="Filter by account name"
          value={state.inputValue}
          onInput={search}
          onSubmit={submitSearch}
        />
      )}
      {state.entriesStatus === 'loading' && <Text dimColor>Loading saved accounts...</Text>}
      {accounts.length > 0 && Select && (
        <Select
          key="account-picker-select"
          label="Account (Up/Down, Enter)"
          options={accounts.map(row => ({ value: row.name, label: label(row) }))}
          value={selectedAccount?.name}
          autoFocus={selectedAccount ? true : undefined}
          onSelect={choose}
        />
      )}
      {selectionNotVisible && <Text dimColor>Current session account: {selectedName} is {selectionFilteredOut ? 'not in these results' : 'outside this page'}.</Text>}
      {!Select && accounts.map(row => (
        <Button key={`account:${row.name}`} plain label={label(row)} onPress={() => choose(row.name)} />
      ))}
      {state.entriesStatus === 'ready' && accountEntries.length === 0 && <Text>{allEntries.length === 0 ? 'No saved accounts are available.' : 'No accounts match this search.'}</Text>}
      {state.loadingRows && <Text dimColor>Loading account details...</Text>}
      {pageLabel && <Text dimColor>{pageLabel}</Text>}
      {canLoadPrevious && <Button key="account-picker-previous" plain label={`Previous ${pageMaximum} accounts`} onPress={previous} />}
      {canLoadMore && <Button key="account-picker-load-more" plain label={`Load more accounts (${pageEnd + 1}-${Math.min(pageEnd + loadMoreCount, accountEntries.length)} of ${accountEntries.length})`} onPress={loadMore} />}
      {state.entriesStatus === 'ready' && !hasMore && accountEntries.length > 0 && <Text dimColor>End of saved accounts.</Text>}
      {error && <Text color="red">{error}</Text>}
      {(state.entriesStatus === 'error' || state.rowError) && <Button key="account-picker-retry" plain label="Retry loading accounts" onPress={retry} />}
      {state.selecting && <Text dimColor>Switching account...</Text>}
      <Button key="account-picker-close" role="dismiss" label="Cancel" onPress={controls.close} />
    </Box>
  )
}
