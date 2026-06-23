// drizzle-orm/sqlite-core helpers — imported here and re-exported so downstream
// policy_* table definitions (added in policy-design) can use them without
// needing to re-import from drizzle-orm.
export {
    sqliteTable,
    text,
    integer,
    index
} from "drizzle-orm/sqlite-core";

// No tables yet — they are added in the policy-design state.
