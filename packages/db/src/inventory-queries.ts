/**
 * Inventory query definitions — PURE DATA. No I/O, no `pg` import, no side effect.
 *
 * WHY THIS FILE IS DATA AND NOTHING ELSE. The collector this feeds is a
 * read-only inspector of a real-money database. Every statement it may ever send
 * is written here, in one place, as a literal string with no parameters and no
 * interpolation — so "what does the inspector do to the database?" is answered
 * by reading one file rather than by tracing a query builder. The CLI enforces
 * the vocabulary again at send time (SELECT, one BEGIN TRANSACTION READ ONLY,
 * one ROLLBACK); this file is what makes that enforcement checkable by eye.
 *
 * ── SCOPE. STAGE A COLLECTS. IT DOES NOT JUDGE. ─────────────────────────────
 *
 * Nothing here compares anything to a policy, and nothing downstream of it may
 * either. A missing object, a role that unexpectedly holds LOGIN, an ACL nobody
 * expected, a version that has drifted — all are *recorded* and none produces a
 * verdict. Enforcement is a separate, later slice; folding it in here would make
 * the first production read of this database also its first policy decision,
 * which is exactly the ordering that must not happen.
 *
 * ── WHY `acldefault` APPEARS AT ALL ─────────────────────────────────────────
 *
 * A NULL ACL column does not mean "no grants". It means the object carries
 * PostgreSQL's built-in default for its object class — which for a FUNCTION is
 * `EXECUTE TO PUBLIC`, not silence. Reading NULL as "nothing is granted" is the
 * classic way an inventory reports a database as tighter than it is. Every ACL
 * query therefore explodes `COALESCE(<acl>, acldefault(<code>, <owner>))` and
 * records, separately, whether the ACL was NULL — so the fact document
 * distinguishes "granted explicitly" from "granted by built-in default" instead
 * of collapsing them.
 *
 * The object-class codes are not interchangeable:
 *   'd' database   'n' schema   'r' relation   's' SEQUENCE
 *   'c' column     'f' function 'T' type
 * A sequence is 's'. Passing 'r' for a sequence yields the wrong default set
 * (INSERT/DELETE/… instead of USAGE/SELECT/UPDATE) and would silently
 * misdescribe every default-ACL sequence in the database.
 */

/** A single statement the collector may send. Parameterless by construction. */
export interface InventoryQuery {
  /** Stable key. Becomes the fact-document section name; never rendered to SQL. */
  readonly id: string
  /** The exact text sent. Must begin with SELECT. */
  readonly sql: string
}

/**
 * Schemas that are PostgreSQL's own furniture rather than this application's.
 *
 * Excluded from object inventory because they are identical on every cluster and
 * would bury the ~70 objects that actually belong to AI Capital. Roles, default
 * ACLs, the database ACL and extension membership are NOT filtered this way —
 * a grant made in `pg_catalog` is exactly the kind of thing an inventory exists
 * to surface.
 */
const SYSTEM_SCHEMA_FILTER = `
    n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND n.nspname NOT LIKE 'pg\\_temp%'
    AND n.nspname NOT LIKE 'pg\\_toast\\_temp%'`

/**
 * The only `pg_class` kinds that carry a grantable ACL.
 *
 * WHY THE FILTER IS NOT COSMETIC. `acldefault('r', owner)` returns the full
 * table privilege set — SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
 * TRIGGER, MAINTAIN — for ANY input. Applied to a row with a NULL `relacl` that
 * is an index ('i'), a partitioned index ('I'), a composite type's row relation
 * ('c') or a TOAST table ('t'), it FABRICATES eight privilege tuples that do
 * not exist and cannot be granted: PostgreSQL has no table privileges on an
 * index, and `GRANT SELECT ON INDEX` is a syntax error. The previous version did
 * exactly that, inventing hundreds of grants and making the database look far
 * more permissive than it is.
 *
 * Indexes are not lost by excluding them here — they have their own facts, with
 * their parent relation, both owners and their three validity flags.
 */
const GRANTABLE_RELKINDS = `'r', 'p', 'v', 'm', 'f', 'S'`

/** PUBLIC is ACL pseudo-grantee 0. It is NOT a row in pg_roles. */
const GRANTEE_NAME = `CASE WHEN x.grantee = 0
             THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(x.grantee) END`

// ── Session identity ────────────────────────────────────────────────────────

export interface SessionIdentityRow {
  current_database: string
  current_user: string
  session_user: string
  transaction_read_only: string
  server_version: string
  server_version_num: string
}

/**
 * Read AFTER `BEGIN TRANSACTION READ ONLY`, never before.
 *
 * `transaction_read_only` is asserted from inside the session rather than
 * assumed from the statement having succeeded, because a connection parameter,
 * `ALTER ROLE ... SET`, a pooler or `default_transaction_read_only` can each
 * change what the session actually got. The collector refuses to read a
 * production database on the strength of a statement it merely *sent*.
 */
export const SESSION_IDENTITY_QUERY: InventoryQuery = {
  id: 'session_identity',
  sql: `SELECT pg_catalog.current_database()                       AS current_database,
       pg_catalog.current_user::text                        AS current_user,
       pg_catalog.session_user::text                        AS session_user,
       pg_catalog.current_setting('transaction_read_only')  AS transaction_read_only,
       pg_catalog.current_setting('server_version')         AS server_version,
       pg_catalog.current_setting('server_version_num')     AS server_version_num`,
}

// ── Server / instance binding ───────────────────────────────────────────────

export interface ServerBindingRow {
  database_name: string
  database_oid: string
  database_owner: string
  server_version: string
  server_version_num: string
  postmaster_start_time: string
  server_port: string
  /** '' is a real, valid value: `cluster_name` defaults to empty. Recorded as
   *  the empty string rather than folded to null, because "unset" and "set to
   *  nothing" are the same thing here and inventing a null would say otherwise. */
  cluster_name: string
  /** NULL for a Unix-socket connection. Together with `socket_directories` this
   *  is the SANITIZED endpoint: where the server is, and nothing about who
   *  connected. */
  server_address: string | null
  socket_directories: string
}

/**
 * The evidence-binding tuple, read from the server.
 *
 * WHY THE ENDPOINT IS DERIVED SERVER-SIDE. The obvious way to record "which
 * endpoint was this?" is to parse the connection string — and that is exactly
 * how a username or a password ends up in an evidence file that then gets
 * mailed around. Worse, `pg-connection-string` OPENS `sslcert`, `sslkey`,
 * `sslrootcert` and `sslcrl` from disk while parsing, so merely inspecting the
 * URL touches the filesystem. Asking the server where it is instead cannot leak
 * a credential, because the server does not know one: `inet_server_addr()`,
 * `inet_server_port()` and `unix_socket_directories` describe the listener, not
 * the client. Host-or-socket-directory, port and database name; no user, no
 * password, no raw URL, anywhere.
 *
 * The database OID is here because the NAME is reusable: drop `ai_capital` and
 * recreate it and every name-based fact still matches while every object is
 * new. The OID says which database this actually was.
 */
export const SERVER_BINDING_QUERY: InventoryQuery = {
  id: 'server_binding',
  sql: `SELECT d.datname AS database_name,
       d.oid::text  AS database_oid,
       pg_catalog.pg_get_userbyid(d.datdba) AS database_owner,
       pg_catalog.current_setting('server_version')     AS server_version,
       pg_catalog.current_setting('server_version_num') AS server_version_num,
       pg_catalog.pg_postmaster_start_time()::text      AS postmaster_start_time,
       pg_catalog.current_setting('port')               AS server_port,
       pg_catalog.current_setting('cluster_name')       AS cluster_name,
       pg_catalog.inet_server_addr()::text              AS server_address,
       pg_catalog.current_setting('unix_socket_directories') AS socket_directories
  FROM pg_catalog.pg_database d
 WHERE d.datname = pg_catalog.current_database()`,
}

// ── Cross-role inspection probes ────────────────────────────────────────────

export interface ProbeRow {
  /** The probe's answer, as the text of a boolean. NULL or absent is a denial. */
  observed: string | null
  /** What was asked about, for the artifact's record. Never a credential. */
  subject: string
  object_description: string
}

/**
 * Capability probes. Each must EVALUATE, against a role that is not this one.
 *
 * WHY COUNTING ROWS WAS THE WRONG TEST. The previous probes counted catalogue
 * rows and asserted the count was at least one. `count(*) + 1` in particular
 * could never be less than one, so it asserted nothing at all; and even an
 * honest `count(*) >= 1` only proves that SOMETHING is visible, not that this
 * session can interrogate privileges belonging to another role. Those are
 * different capabilities and they fail separately.
 *
 * WHY THESE THREE. `has_table_privilege`, `has_schema_privilege` and
 * `pg_has_role` are the three functions the enforcement slice will be built on,
 * and each RAISES rather than returning a wrong answer when the session may not
 * ask: an object it cannot see, or a role that does not exist, is an error, not
 * a `false`. So evaluability is the signal, and a denial is loud.
 *
 * WHY "AGAINST A NON-SELF ROLE" IS THE POINT. Asking these about
 * `current_user` is nearly free and proves nothing — a session can always
 * interrogate itself. The whole risk being guarded against is a session that
 * can see its own corner of the catalogue and silently less of everyone else's,
 * which would produce an inventory that looks complete and is not. Each probe
 * therefore selects a subject role that is explicitly NOT the current user, and
 * a target object that role owns; if no such row exists, the probe returns no
 * row and the collector fails closed rather than guessing whether the database
 * is empty or the view is filtered.
 *
 * WHAT IS *NOT* ASSERTED. The boolean's VALUE. An owner normally holds every
 * privilege on its own object, but `REVOKE ... FROM` an owner is legal, and a
 * collector that refused to inventory a database because of that would be
 * enforcing a policy — which this slice must not do. A non-NULL boolean means
 * the question was answerable; that is the whole claim.
 */
export const PROBE_QUERIES: readonly InventoryQuery[] = Object.freeze([
  {
    id: 'probe_has_table_privilege',
    sql: `SELECT pg_catalog.has_table_privilege(c.relowner, c.oid, 'SELECT')::text AS observed,
       pg_catalog.pg_get_userbyid(c.relowner) AS subject,
       pg_catalog.pg_describe_object('pg_class'::regclass, c.oid, 0) AS object_description
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
   AND c.relowner <> (SELECT r.oid FROM pg_catalog.pg_roles r
                       WHERE r.rolname = pg_catalog.current_user::text)
 ORDER BY n.nspname, c.relname
 LIMIT 1`,
  },
  {
    id: 'probe_has_schema_privilege',
    sql: `SELECT pg_catalog.has_schema_privilege(n.nspowner, n.oid, 'USAGE')::text AS observed,
       pg_catalog.pg_get_userbyid(n.nspowner) AS subject,
       pg_catalog.pg_describe_object('pg_namespace'::regclass, n.oid, 0) AS object_description
  FROM pg_catalog.pg_namespace n
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND n.nspowner <> (SELECT r.oid FROM pg_catalog.pg_roles r
                       WHERE r.rolname = pg_catalog.current_user::text)
 ORDER BY n.nspname
 LIMIT 1`,
  },
  {
    id: 'probe_pg_has_role',
    sql: `SELECT pg_catalog.pg_has_role(a.rolname, b.oid, 'MEMBER')::text AS observed,
       a.rolname AS subject,
       pg_catalog.pg_describe_object('pg_authid'::regclass, b.oid, 0) AS object_description
  FROM pg_catalog.pg_roles a
  JOIN pg_catalog.pg_roles b ON b.oid <> a.oid
 WHERE a.rolname <> pg_catalog.current_user::text
   AND b.rolname <> pg_catalog.current_user::text
 ORDER BY a.rolname, b.rolname
 LIMIT 1`,
  },
])

// ── Row shapes ──────────────────────────────────────────────────────────────

export interface SchemaMigrationRow {
  filename: string
  sha256: string
  applied_at: string
}

export interface AclTupleFields {
  /** true when the catalogue column was NULL, i.e. these are BUILT-IN defaults. */
  acl_is_default: boolean
  grantor: string | null
  grantee: string | null
  privilege_type: string | null
  is_grantable: boolean | null
}

export interface DatabaseAclRow extends AclTupleFields {
  datname: string
  datoid: string
  owner: string
  datallowconn: boolean
  datconnlimit: string
}

export interface SchemaRow extends AclTupleFields {
  schema_name: string
  owner: string
}

export interface RelationRow extends AclTupleFields {
  schema_name: string
  object_name: string
  relkind: string
  owner: string
  rowsecurity: boolean
  forcerowsecurity: boolean
  persistence: string
}

export interface ColumnRow extends AclTupleFields {
  schema_name: string
  object_name: string
  column_name: string
  attnum: string
  owner: string
}

export interface SequenceRow {
  schema_name: string
  object_name: string
  owner: string
  owned_by_schema: string | null
  owned_by_table: string | null
  owned_by_column: string | null
}

export interface RoutineRow extends AclTupleFields {
  schema_name: string
  object_name: string
  identity_arguments: string
  prokind: string
  owner: string
  security_definer: boolean
  proconfig: string | null
}

export interface TypeRow extends AclTupleFields {
  schema_name: string
  object_name: string
  typtype: string
  owner: string
}

export interface DefaultAclRow extends AclTupleFields {
  /** NULL nspname is the GLOBAL row (defaclnamespace = 0) — it REPLACES the
   *  hardwired default. A per-schema row is ADDITIVE and cannot remove a grant
   *  the global or hardwired default conferred. Recorded distinctly for that
   *  reason; the distinction is lost the moment they are merged. */
  schema_name: string | null
  target_role: string
  object_class: string
}

export interface RoleRow {
  rolname: string
  rolsuper: boolean
  rolinherit: boolean
  rolcreaterole: boolean
  rolcreatedb: boolean
  rolcanlogin: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolconnlimit: string
  rolvaliduntil: string | null
  rolconfig: string | null
}

export interface RoleMembershipRow {
  member: string
  granted_role: string
  admin_option: boolean
  /**
   * PostgreSQL 16 split what used to be one flag into three. ADMIN may grant the
   * role onward; INHERIT decides whether the member gets the role's privileges
   * automatically; SET decides whether it may `SET ROLE` to it. A membership
   * with SET and without INHERIT is the shape the tenancy design depends on —
   * the migrator may ASSUME `ai_capital_owner` inside a window and does not
   * silently carry its privileges the rest of the time — and recording only
   * `admin_option` erases exactly that distinction.
   *
   * Read through `to_jsonb(a) ->> '...'`, which yields NULL on a server that has
   * no such column, so this query runs unchanged on PostgreSQL 15 and earlier
   * and says "not recorded" rather than failing or inventing a default.
   */
  inherit_option: string | null
  set_option: string | null
  grantor: string
}

export interface PolicyRow {
  schema_name: string
  table_name: string
  policy_name: string
  permissive: string
  policy_roles: string
  command: string
  using_expression: string | null
  check_expression: string | null
}

export interface IndexRow {
  schema_name: string
  table_name: string
  index_name: string
  table_owner: string
  index_owner: string
  is_unique: boolean
  is_primary: boolean
  is_exclusion: boolean
  is_valid: boolean
  is_ready: boolean
  is_live: boolean
  index_definition: string
}

export interface TriggerRow {
  schema_name: string
  table_name: string
  trigger_name: string
  is_internal: boolean
  is_enabled: string
  trigger_definition: string
}

export interface ExtensionRow {
  extension_name: string
  owner: string
  schema_name: string | null
  version: string
  relocatable: boolean
}

export interface ExtensionMemberRow {
  extension_name: string
  extension_version: string
  classid: string
  objid: string
  objsubid: string
  /** NULL when `classid` names no catalogue this server exposes. */
  catalogue: string | null
  /**
   * `pg_describe_object`'s rendering — "function public.vector_out(vector)",
   * "operator family public.vector_ops for access method hnsw", and so on.
   *
   * WHY IT IS COLLECTED. An extension owns objects from catalogues an inventory
   * has no dedicated section for: operators, operator classes and families,
   * access methods, casts, collations, transforms. Recording only OIDs would
   * make them unreadable, and recording only the sections we happen to model
   * would make them DISAPPEAR. `pg_describe_object` names every class the server
   * knows, so an unusual member is described rather than dropped.
   */
  object_description: string | null
}

export interface DependencyEdgeRow {
  classid: string
  objid: string
  objsubid: string
  refclassid: string
  refobjid: string
  refobjsubid: string
  deptype: string
  catalogue: string | null
  ref_catalogue: string | null
  object_description: string | null
  ref_object_description: string | null
}

/**
 * An object that lives in schema `public`, discovered by OBJECT ADDRESS.
 *
 * Deliberately carries no `schema_name`, `object_name`, `object_kind` or
 * `owner`: those columns exist on `pg_class`, `pg_proc` and `pg_type` and on
 * nothing else, so demanding them is exactly what limited the previous version
 * to three catalogues. Identity here is the address PostgreSQL itself uses —
 * `(classid, objid, objsubid)` — plus whatever `pg_describe_object` can say
 * about it, which is every class the server knows.
 */
export interface PublicObjectRow {
  classid: string
  objid: string
  objsubid: string
  /** NULL when `classid` names no catalogue this server exposes. */
  catalogue: string | null
  object_description: string | null
}

// ── Inventory queries ───────────────────────────────────────────────────────

export const INVENTORY_QUERIES: readonly InventoryQuery[] = Object.freeze([
  {
    id: 'schema_migrations',
    sql: `SELECT m.filename, m.sha256, m.applied_at::text AS applied_at
  FROM db.schema_migrations m
 ORDER BY m.filename`,
  },
  {
    id: 'database_acl',
    sql: `SELECT d.datname,
       d.oid::text AS datoid,
       pg_catalog.pg_get_userbyid(d.datdba) AS owner,
       d.datallowconn,
       d.datconnlimit::text AS datconnlimit,
       (d.datacl IS NULL)   AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_database d
  LEFT JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) AS x ON true
 WHERE d.datname = pg_catalog.current_database()
 ORDER BY d.datname, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'schemas',
    sql: `SELECT n.nspname AS schema_name,
       pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
       (n.nspacl IS NULL) AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_namespace n
  LEFT JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) AS x ON true
 WHERE ${SYSTEM_SCHEMA_FILTER}
 ORDER BY n.nspname, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'relations',
    sql: `SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       c.relkind::text AS relkind,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity      AS rowsecurity,
       c.relforcerowsecurity AS forcerowsecurity,
       c.relpersistence::text AS persistence,
       (c.relacl IS NULL) AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(c.relacl,
                  pg_catalog.acldefault(
                    CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END, c.relowner))) AS x ON true
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND c.relkind IN (${GRANTABLE_RELKINDS})
 ORDER BY n.nspname, c.relname, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'columns',
    sql: `SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       a.attname AS column_name,
       a.attnum::text AS attnum,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       false AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c     ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS x ON true
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND c.relkind IN (${GRANTABLE_RELKINDS})
   AND a.attnum > 0
   AND NOT a.attisdropped
   AND a.attacl IS NOT NULL
 ORDER BY n.nspname, c.relname, a.attnum, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'sequences',
    sql: `SELECT n.nspname AS schema_name,
       c.relname AS object_name,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       dn.nspname AS owned_by_schema,
       dc.relname AS owned_by_table,
       da.attname AS owned_by_column
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_depend d
         ON d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.refclassid = 'pg_class'::regclass
        AND d.deptype = 'a'
  LEFT JOIN pg_catalog.pg_class c2     ON c2.oid = d.refobjid
  LEFT JOIN pg_catalog.pg_class dc     ON dc.oid = c2.oid
  LEFT JOIN pg_catalog.pg_namespace dn ON dn.oid = dc.relnamespace
  LEFT JOIN pg_catalog.pg_attribute da
         ON da.attrelid = d.refobjid AND da.attnum = d.refobjsubid
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND c.relkind = 'S'
 ORDER BY n.nspname, c.relname`,
  },
  {
    id: 'routines',
    sql: `SELECT n.nspname AS schema_name,
       p.proname AS object_name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prokind::text AS prokind,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       pg_catalog.array_to_string(p.proconfig, ', ') AS proconfig,
       (p.proacl IS NULL) AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x ON true
 WHERE ${SYSTEM_SCHEMA_FILTER}
 ORDER BY n.nspname, p.proname, identity_arguments, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'types',
    sql: `SELECT n.nspname AS schema_name,
       t.typname AS object_name,
       t.typtype::text AS typtype,
       pg_catalog.pg_get_userbyid(t.typowner) AS owner,
       (t.typacl IS NULL) AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(t.typacl, pg_catalog.acldefault('T', t.typowner))) AS x ON true
 WHERE ${SYSTEM_SCHEMA_FILTER}
   AND t.typtype <> 'b'
 ORDER BY n.nspname, t.typname, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'default_acls',
    sql: `SELECT n.nspname AS schema_name,
       pg_catalog.pg_get_userbyid(d.defaclrole) AS target_role,
       d.defaclobjtype::text AS object_class,
       false AS acl_is_default,
       pg_catalog.pg_get_userbyid(x.grantor) AS grantor,
       ${GRANTEE_NAME} AS grantee,
       x.privilege_type,
       x.is_grantable
  FROM pg_catalog.pg_default_acl d
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
  JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) AS x ON true
 ORDER BY target_role, schema_name, object_class, grantee, x.privilege_type, x.is_grantable`,
  },
  {
    id: 'roles',
    sql: `SELECT r.rolname,
       r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb,
       r.rolcanlogin, r.rolreplication, r.rolbypassrls,
       r.rolconnlimit::text AS rolconnlimit,
       r.rolvaliduntil::text AS rolvaliduntil,
       pg_catalog.array_to_string(r.rolconfig, ', ') AS rolconfig
  FROM pg_catalog.pg_roles r
 ORDER BY r.rolname`,
  },
  {
    id: 'role_memberships',
    sql: `SELECT m.rolname AS member,
       g.rolname AS granted_role,
       a.admin_option,
       (pg_catalog.to_jsonb(a) ->> 'inherit_option') AS inherit_option,
       (pg_catalog.to_jsonb(a) ->> 'set_option')     AS set_option,
       o.rolname AS grantor
  FROM pg_catalog.pg_auth_members a
  JOIN pg_catalog.pg_roles m ON m.oid = a.member
  JOIN pg_catalog.pg_roles g ON g.oid = a.roleid
  JOIN pg_catalog.pg_roles o ON o.oid = a.grantor
 ORDER BY member, granted_role, grantor`,
  },
  {
    id: 'policies',
    sql: `SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       p.polname AS policy_name,
       CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
       COALESCE(pg_catalog.array_to_string(ARRAY(
         SELECT pg_catalog.pg_get_userbyid(oid) FROM pg_catalog.unnest(p.polroles) AS oid
       ), ', '), '') AS policy_roles,
       p.polcmd::text AS command,
       pg_catalog.pg_get_expr(p.polqual, p.polrelid)      AS using_expression,
       pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c     ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${SYSTEM_SCHEMA_FILTER}
 ORDER BY n.nspname, c.relname, p.polname`,
  },
  {
    id: 'indexes',
    sql: `SELECT n.nspname AS schema_name,
       t.relname AS table_name,
       i.relname AS index_name,
       pg_catalog.pg_get_userbyid(t.relowner) AS table_owner,
       pg_catalog.pg_get_userbyid(i.relowner) AS index_owner,
       ix.indisunique    AS is_unique,
       ix.indisprimary   AS is_primary,
       ix.indisexclusion AS is_exclusion,
       ix.indisvalid     AS is_valid,
       ix.indisready     AS is_ready,
       ix.indislive      AS is_live,
       pg_catalog.pg_get_indexdef(ix.indexrelid) AS index_definition
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class i     ON i.oid = ix.indexrelid
  JOIN pg_catalog.pg_class t     ON t.oid = ix.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
 WHERE ${SYSTEM_SCHEMA_FILTER}
 ORDER BY n.nspname, t.relname, i.relname`,
  },
  {
    id: 'triggers',
    sql: `SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       tg.tgname AS trigger_name,
       tg.tgisinternal AS is_internal,
       tg.tgenabled::text AS is_enabled,
       CASE WHEN tg.tgisinternal THEN ''
            ELSE pg_catalog.pg_get_triggerdef(tg.oid) END AS trigger_definition
  FROM pg_catalog.pg_trigger tg
  JOIN pg_catalog.pg_class c     ON c.oid = tg.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE ${SYSTEM_SCHEMA_FILTER}
 ORDER BY n.nspname, c.relname, tg.tgname`,
  },
  {
    id: 'extensions',
    sql: `SELECT e.extname AS extension_name,
       pg_catalog.pg_get_userbyid(e.extowner) AS owner,
       n.nspname AS schema_name,
       e.extversion AS version,
       e.extrelocatable AS relocatable
  FROM pg_catalog.pg_extension e
  LEFT JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
 ORDER BY e.extname`,
  },
  {
    id: 'extension_members',
    sql: `SELECT e.extname     AS extension_name,
       e.extversion AS extension_version,
       d.classid::text  AS classid,
       d.objid::text    AS objid,
       d.objsubid::text AS objsubid,
       cat.relname      AS catalogue,
       pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS object_description
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
  LEFT JOIN pg_catalog.pg_class cat ON cat.oid = d.classid
 WHERE d.refclassid = 'pg_extension'::regclass
   AND d.deptype = 'e'
 ORDER BY e.extname, classid, objid, objsubid`,
  },
  {
    id: 'dependency_edges',
    sql: `SELECT d.classid::text     AS classid,
       d.objid::text       AS objid,
       d.objsubid::text    AS objsubid,
       d.refclassid::text  AS refclassid,
       d.refobjid::text    AS refobjid,
       d.refobjsubid::text AS refobjsubid,
       d.deptype::text     AS deptype,
       cat.relname         AS catalogue,
       refcat.relname      AS ref_catalogue,
       pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)          AS object_description,
       pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS ref_object_description
  FROM pg_catalog.pg_depend d
  LEFT JOIN pg_catalog.pg_class cat    ON cat.oid = d.classid
  LEFT JOIN pg_catalog.pg_class refcat ON refcat.oid = d.refclassid
 WHERE d.deptype IN ('i', 'a')
 ORDER BY classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype`,
  },
  {
    // The FOURTH class of evidence. An 'n' (normal) dependency is how an
    // ordinary application object says "I use something an extension provides"
    // — a column of type `vector`, an index using `hnsw`, an exclusion
    // constraint reaching btree_gist's operators. It is not extension
    // membership: dropping the extension does not drop the table, it refuses.
    // Recorded as its own relation so a later slice can decide what any of it
    // means; nothing is decided here.
    id: 'normal_dependency_edges',
    sql: `SELECT d.classid::text     AS classid,
       d.objid::text       AS objid,
       d.objsubid::text    AS objsubid,
       d.refclassid::text  AS refclassid,
       d.refobjid::text    AS refobjid,
       d.refobjsubid::text AS refobjsubid,
       d.deptype::text     AS deptype,
       cat.relname         AS catalogue,
       refcat.relname      AS ref_catalogue,
       pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)          AS object_description,
       pg_catalog.pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS ref_object_description
  FROM pg_catalog.pg_depend d
  LEFT JOIN pg_catalog.pg_class cat    ON cat.oid = d.classid
  LEFT JOIN pg_catalog.pg_class refcat ON refcat.oid = d.refclassid
 WHERE d.deptype = 'n'
 ORDER BY classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype`,
  },
  {
    // ── THE FOURTH CLASS'S UNIVERSE, AND WHY IT IS `public` ONLY ───────────
    //
    // The previous version listed pg_class, pg_proc and pg_type across every
    // non-system schema, and got the category wrong in both directions at once.
    //
    // TOO MUCH: every ordinary table in `portfolio`, `identity`,
    // `investment_ledger` and `desk` came back labelled "unrelated" for the
    // sole reason that it does not depend on an extension — which is true of
    // essentially the whole application and says nothing about anything. The
    // question the fourth class exists to answer is narrower: what is sitting
    // in `public`, the one schema the bootstrap installs extensions into and
    // then revokes from PUBLIC, that no extension accounts for?
    //
    // TOO LITTLE: three catalogues is not "objects". An operator, an operator
    // class, an operator family, a conversion, a collation or a text-search
    // configuration parked in `public` was invisible — and those are precisely
    // the shapes that arrive alongside extension work and get left behind.
    //
    // The fix is to stop enumerating catalogues and ask by OBJECT ADDRESS.
    // Every schema-qualified object records a NORMAL dependency on its
    // namespace — `heap_create_with_catalog`, `ProcedureCreate`, `TypeCreate`,
    // `OperatorCreate`, `CreateOpClass` and the rest all call
    // `recordDependencyOn(... namespace ..., DEPENDENCY_NORMAL)` so that
    // dropping the schema is refused while the object lives — so one query over
    // `pg_depend` finds them all, whatever catalogue they belong to, and
    // `pg_describe_object` names them.
    id: 'public_objects',
    sql: `SELECT d.classid::text  AS classid,
       d.objid::text    AS objid,
       d.objsubid::text AS objsubid,
       cat.relname      AS catalogue,
       pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS object_description
  FROM pg_catalog.pg_depend d
  LEFT JOIN pg_catalog.pg_class cat ON cat.oid = d.classid
 WHERE d.refclassid = 'pg_namespace'::regclass
   AND d.deptype = 'n'
   AND d.refobjid = (SELECT n.oid FROM pg_catalog.pg_namespace n
                      WHERE n.nspname = 'public')
 ORDER BY classid, objid, objsubid`,
  },
])

// ── The migration manifest, as DATA ─────────────────────────────────────────

export interface ManifestEntry {
  readonly filename: string
  readonly sha256: string
}

/**
 * The eighteen migrations that constitute the current published schema.
 *
 * Recorded as filename AND content hash because either alone is defeatable: a
 * ledger row can name a migration whose file has since changed, and a hash
 * alone cannot say which migration it belongs to. `migrate.ts` computes the
 * same digest — sha256 over the file's UTF-8 bytes — so a match here means the
 * database was built from exactly these bytes.
 *
 * There is no V19 entry, deliberately. A manifest that already knew about a
 * migration nobody has written would let a database that had somehow acquired
 * one be recognised as expected.
 */
export const CURRENT_V18_MANIFEST: readonly ManifestEntry[] = Object.freeze([
  { filename: '001_portfolio.sql', sha256: '326fe2c3d266f62a6a3f1525ec95b0489906bd44aec7c5628e026d049626b13d' },
  { filename: '002_capital.sql', sha256: 'a41f43c8f3784dcc4c40b4de5d0da029c884517a8e9444bc41e1f8abeae46ec1' },
  { filename: '003_thesis.sql', sha256: 'e5dae3cc3c9952190a3fb8e8008a8f27997a3695dd2fd1413e32cce55087befa' },
  { filename: '004_briefing.sql', sha256: '8bd054743d2028ae9ef7e4492b8b9b9ebe009825327489bce0e927c9c5ed5d36' },
  { filename: '005_graph.sql', sha256: '45d6f496fc24f21e7b9eb8cc76dbde439504cc4a350cb6cc38811be262073686' },
  { filename: '006_vectors.sql', sha256: '948c04ee131362647b07bfe6313ca59a8f15c3d24b29cdd7f8013ffe9c6916cb' },
  { filename: '007_trade.sql', sha256: '9f387f8016f1d8362ce3e8858a0aa8e468492d935357604e8c5a7ccd7277e2d3' },
  { filename: '008_desk.sql', sha256: '70b1d380f6163bde19bf4e9896f7f5e54c5df861c3c760b82092f9db53e78db4' },
  { filename: '009_claim_governance.sql', sha256: '3f8dfef4e9e1a3ba0a75121f3b4f58be4669c057681a7dcb275cf8488f9852eb' },
  { filename: '010_correct_claim_history.sql', sha256: '52a23fe5e60c350c9c9cac4a7c5c081ac19ceb01095f6c5593a2c673b010f38f' },
  { filename: '011_identity_foundation.sql', sha256: '42b80f27f0d806794020364f9d7c20d62930afcb3d65cafa06e735b62cec3e9f' },
  { filename: '012_identity_security.sql', sha256: '24599da6f61a5253466c275970b36c9c96174ac6645b314b9d9d6a175ad1f4f3' },
  { filename: '013_investment_ledger.sql', sha256: 'c5d2d52c509a1d1bdbcb46d3ca7891b36113a159410af8328d310ceca64d2e29' },
  { filename: '014_investment_ledger_remediation.sql', sha256: 'c9e731613e655849e608d8a78e4556772876e7959b0fa0b50097e5d4c8fcd248' },
  { filename: '015_investment_ledger_series_and_corrections.sql', sha256: 'd076798413e5285a91fe6ce1252d715cffa208237cfd8c6de96f2cf0c3e13616' },
  { filename: '016_investment_ledger_enforcement.sql', sha256: 'daa8fc3dd05d03197ec31d57d832d10a930d1a50d42ef53208e1d838fd63ddac' },
  { filename: '017_ledger_views_rls_grants.sql', sha256: 'e069433155d74ae7553ea41a08c909f03ca87b8c0e882c745b40d54b36bdefa1' },
  { filename: '018_legacy_runtime_grants.sql', sha256: '7632ef07ed2d5cd7101e5c684f23bea7c68080ffe51f6b9e260df3572f2d1f50' },
])

/** The database this collector is written for. Asserted from inside the session. */
export const EXPECTED_DATABASE = 'ai_capital'

/**
 * The only principal authorised to run the inventory.
 *
 * Asserted for BOTH `current_user` and `session_user`: they differ under
 * `SET ROLE`, and an inventory taken while impersonating another role describes
 * that role's view, not the deployment identity's. The collector never issues
 * `SET ROLE` and refuses to run if something else already has.
 */
export const EXPECTED_PRINCIPAL = 'ai_capital_migrator'
