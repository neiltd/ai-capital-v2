// A canonical, OID-independent picture of who can do what, taken before a
// temporary role exists and again after it is gone.
//
// WHAT THIS IS FOR. "We revoked everything" is not a statement anyone can check
// by reading the revoke script - the script can be complete and still leave a
// default ACL, a membership, or an ownership change behind. Two censuses that
// are byte-identical is a statement that can be checked, and it is the only one
// worth making.
//
// WHY NAMES AND NEVER OIDS. A role dropped and recreated has a different OID and
// the same name. A census keyed on OIDs would call that a change; a census keyed
// on names calls it what it is. OIDs are also unstable across the very
// provisioning this census exists to bracket.
//
// WHY acldefault() BEFORE aclexplode(). A NULL relacl means "the built-in
// default", and GRANT ALL ON t TO owner writes that same default out explicitly.
// They are the same authority, so they must produce the same census rows -
// otherwise granting something that changes nothing would read as drift.
// Normalizing NULL through acldefault() first makes the two identical, which is
// exactly why no acl_is_default marker is emitted: such a marker would
// reintroduce the difference it was meant to describe.

import { createHash } from 'node:crypto'

export class CensusRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CensusRefused'
  }
}

const NON_SYSTEM = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`

/** Role attributes. rolpassword is never read. */
export const CENSUS_ROLES_SQL = `
SELECT r.rolname,
       r.rolsuper::pg_catalog.text, r.rolinherit::pg_catalog.text,
       r.rolcreaterole::pg_catalog.text, r.rolcreatedb::pg_catalog.text,
       r.rolcanlogin::pg_catalog.text, r.rolreplication::pg_catalog.text,
       r.rolbypassrls::pg_catalog.text, r.rolconnlimit::pg_catalog.text,
       COALESCE(r.rolvaliduntil::pg_catalog.text, '')
  FROM pg_catalog.pg_roles r
 ORDER BY r.rolname`

/** Per-role/per-database settings. A 0 role or database renders as an empty name. */
export const CENSUS_ROLCONFIG_SQL = `
SELECT COALESCE(r.rolname, ''), COALESCE(d.datname, ''), cfg
  FROM pg_catalog.pg_db_role_setting s
  LEFT JOIN pg_catalog.pg_roles r    ON r.oid = s.setrole
  LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
  CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS cfg
 ORDER BY 1, 2, 3`

export const CENSUS_MEMBERSHIPS_SQL = `
SELECT ro.rolname, me.rolname, gr.rolname,
       m.admin_option::pg_catalog.text,
       m.inherit_option::pg_catalog.text,
       m.set_option::pg_catalog.text
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles ro ON ro.oid = m.roleid
  JOIN pg_catalog.pg_roles me ON me.oid = m.member
  JOIN pg_catalog.pg_roles gr ON gr.oid = m.grantor
 ORDER BY 1, 2, 3, 4, 5, 6`

export const CENSUS_DATABASE_SQL = `
SELECT d.datname,
       pg_catalog.pg_get_userbyid(d.datdba),
       d.datconnlimit::pg_catalog.text,
       d.datallowconn::pg_catalog.text,
       d.datistemplate::pg_catalog.text,
       pg_catalog.pg_encoding_to_char(d.encoding),
       d.datcollate, d.datctype,
       pg_catalog.pg_get_userbyid(a.grantor),
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
       a.privilege_type, a.is_grantable::pg_catalog.text
  FROM pg_catalog.pg_database d
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) AS a
 WHERE d.datname = pg_catalog.current_database()
 ORDER BY 1, 9, 10, 11, 12`

export const CENSUS_SCHEMAS_SQL = `
SELECT n.nspname,
       pg_catalog.pg_get_userbyid(n.nspowner),
       pg_catalog.pg_get_userbyid(a.grantor),
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
       a.privilege_type, a.is_grantable::pg_catalog.text
  FROM pg_catalog.pg_namespace n
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS a
 WHERE ${NON_SYSTEM}
 ORDER BY 1, 3, 4, 5, 6`

export const CENSUS_RELATIONS_SQL = `
SELECT n.nspname || '.' || c.relname, c.relkind::pg_catalog.text,
       pg_catalog.pg_get_userbyid(c.relowner),
       pg_catalog.pg_get_userbyid(a.grantor),
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
       a.privilege_type, a.is_grantable::pg_catalog.text
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(c.relacl, pg_catalog.acldefault(
      CASE WHEN c.relkind = 'S' THEN 'S' ELSE 'r' END::pg_catalog."char", c.relowner))) AS a
 WHERE ${NON_SYSTEM} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
 ORDER BY 1, 4, 5, 6, 7`

/** Column ACLs. This is where the two-column ledger grant lives. */
export const CENSUS_COLUMNS_SQL = `
SELECT n.nspname || '.' || c.relname || '.' || at.attname,
       pg_catalog.pg_get_userbyid(c.relowner),
       pg_catalog.pg_get_userbyid(a.grantor),
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
       a.privilege_type, a.is_grantable::pg_catalog.text
  FROM pg_catalog.pg_attribute at
  JOIN pg_catalog.pg_class c     ON c.oid = at.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(at.attacl, pg_catalog.acldefault('c'::pg_catalog."char", c.relowner))) AS a
 WHERE ${NON_SYSTEM} AND at.attnum > 0 AND NOT at.attisdropped
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
 ORDER BY 1, 3, 4, 5, 6`

export const CENSUS_DEFAULT_ACLS_SQL = `
SELECT pg_catalog.pg_get_userbyid(d.defaclrole),
       COALESCE(n.nspname, ''), d.defaclobjtype::pg_catalog.text,
       pg_catalog.pg_get_userbyid(a.grantor),
       CASE WHEN a.grantee = 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
       a.privilege_type, a.is_grantable::pg_catalog.text
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS a
 ORDER BY 1, 2, 3, 4, 5, 6, 7`

export const CENSUS_QUERIES: readonly string[] = Object.freeze([
  CENSUS_ROLES_SQL, CENSUS_ROLCONFIG_SQL, CENSUS_MEMBERSHIPS_SQL, CENSUS_DATABASE_SQL,
  CENSUS_SCHEMAS_SQL, CENSUS_RELATIONS_SQL, CENSUS_COLUMNS_SQL, CENSUS_DEFAULT_ACLS_SQL,
])

export interface RawCensus {
  readonly roles: readonly (readonly string[])[]
  readonly rolconfig: readonly (readonly string[])[]
  readonly memberships: readonly (readonly string[])[]
  readonly database: readonly (readonly string[])[]
  readonly schemas: readonly (readonly string[])[]
  readonly relations: readonly (readonly string[])[]
  readonly columns: readonly (readonly string[])[]
  readonly defaultAcls: readonly (readonly string[])[]
}

export interface CensusOptions {
  /**
   * The ONE role name whose own records may be omitted, and only while it
   * exists. Matching is exact equality - never a prefix, never a pattern - so a
   * pre-existing role whose name merely begins the same way is still censused.
   */
  readonly excludeRoleExactly?: string
}

const sortRows = (rows: readonly (readonly string[])[]): string[][] =>
  rows.map(r => [...r]).sort((a, b) => {
    const x = JSON.stringify(a)
    const y = JSON.stringify(b)
    return x < y ? -1 : x > y ? 1 : 0
  })

/**
 * The canonical census document.
 *
 * Deterministic: every section is sorted here, not merely in SQL, so a planner
 * change cannot reorder a section and read as drift.
 */
export function censusJson(raw: RawCensus, options: CensusOptions = {}): string {
  const drop = options.excludeRoleExactly
  if (drop === '') {
    throw new CensusRefused('an empty exclusion name would exclude nothing and hide that fact.')
  }
  // Exact equality only. A prefix test here is the whole difference between
  // "the temporary role is excluded" and "anything that looks like it is".
  const isDropped = (name: string): boolean => drop !== undefined && name === drop

  const sections = {
    roles: sortRows(raw.roles).filter(r => !isDropped(r[0])),
    rolconfig: sortRows(raw.rolconfig).filter(r => !isDropped(r[0])),
    // A membership is dropped only when the excluded role IS the granted role
    // or the member. Dropping it because the role happened to be the GRANTOR
    // would erase a grant BETWEEN TWO PRE-EXISTING ROLES that outlives the
    // temporary role entirely - the census would call that clean.
    memberships: sortRows(raw.memberships)
      .filter(r => !isDropped(r[0]) && !isDropped(r[1])),
    // For ACL sections only the GRANTEE may be the excluded role. A grantor is a
    // pre-existing role and its records stay.
    database: sortRows(raw.database).filter(r => !isDropped(r[9])),
    schemas: sortRows(raw.schemas).filter(r => !isDropped(r[3])),
    relations: sortRows(raw.relations).filter(r => !isDropped(r[4])),
    columns: sortRows(raw.columns).filter(r => !isDropped(r[3])),
    default_acls: sortRows(raw.defaultAcls).filter(r => !isDropped(r[4])),
  }
  return `${JSON.stringify(sections, null, 2)}\n`
}

export function censusDigest(document: string): string {
  return createHash('sha256').update(document, 'utf-8').digest('hex')
}
