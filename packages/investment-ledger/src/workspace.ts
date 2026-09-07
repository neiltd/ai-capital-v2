// Workspace selection for the ledger package.
//
// THE CONTRACT: an exact UUID, supplied explicitly, or nothing.
//
// There is no default, no environment variable, no "current" workspace and no
// inference from the connection. A slug is not accepted here either — slugs are
// resolved by `identity.resolve_workspace_for_capability`, which authorizes
// BEFORE it resolves, so an unentitled slug and a nonexistent one both return
// nothing and neither becomes an enumeration oracle.

export const WORKSPACE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertWorkspaceId(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') {
    throw new Error(
      '--workspace <uuid> is required and has no default. The ledger will not ' +
      'guess which workspace it is writing into.',
    )
  }
  const id = value.trim()
  if (!WORKSPACE_UUID.test(id)) {
    throw new Error(
      `--workspace must be an exact UUID, got '${id}'. Resolve a slug with ` +
      'identity.resolve_workspace_for_capability, which checks entitlement first.',
    )
  }
  return id.toLowerCase()
}
