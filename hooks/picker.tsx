import type { Elements, RenderElement, RenderSurface, UiOpenResult } from 'claude-code'

export type AccountRow = { name: string; kind: string; email: string; tier: string; selected: boolean }
export type PickerControls = { invalidate: () => void; log: (text: string) => void; close: () => Promise<void> }

export const ACCOUNT_PICKER_ID = 'rice-account-picker'
let error: string | undefined
let selecting = false

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function label(row: AccountRow): string {
  return `${row.selected ? '* ' : ''}${row.name} | ${row.email || 'email unavailable'} | ${row.tier || 'tier unavailable'}${row.selected ? ' | current session' : ''}`
}

/** Opens a native picker when this session has a surface that places panes. */
export async function openAccountPicker(open: () => Promise<UiOpenResult>): Promise<boolean> {
  error = undefined
  const opened = await open()
  return opened.isPlaced
}

/** The switch callback succeeds with its status text, or throws to keep the picker open. */
export async function renderAccountPicker(
  elements: Elements[RenderSurface],
  rows: () => Promise<AccountRow[]>,
  select: (name: string) => Promise<string>,
  controls: PickerControls,
): Promise<RenderElement> {
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  let accounts: AccountRow[] = []
  let loadError: string | undefined
  try {
    accounts = await rows()
  } catch (caught) {
    loadError = message(caught)
  }

  const choose = async (name: string): Promise<void> => {
    if (selecting) return
    selecting = true
    error = undefined
    controls.invalidate()
    try {
      const result = await select(name)
      if (result) controls.log(result)
      await controls.close()
    } catch (caught) {
      error = message(caught)
    } finally {
      selecting = false
      controls.invalidate()
    }
  }

  return (
    <Box flexDirection="column">
      <Text>Choose an account for this session</Text>
      <Text dimColor>Other sessions keep their accounts. Escape closes this list.</Text>
      {accounts.length > 0 && Select && (
        <Select
          key="account-picker-select"
          label="Account (Up/Down, Enter)"
          options={accounts.map(row => ({ value: row.name, label: label(row) }))}
          value={accounts.find(row => row.selected)?.name ?? accounts[0]?.name}
          autoFocus
          onSelect={choose}
        />
      )}
      {accounts.map(row => (
        <Button key={`account:${row.name}`} plain label={label(row)} onPress={() => choose(row.name)} />
      ))}
      {accounts.length === 0 && !loadError && <Text>No saved accounts are available.</Text>}
      {selecting && <Text dimColor>Switching account...</Text>}
      {(error || loadError) && <Text color="red">{error || loadError}</Text>}
      <Button key="account-picker-close" role="dismiss" label="Cancel" onPress={controls.close} />
    </Box>
  )
}
