import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const agentsTable = sqliteTable("agents", {
    name: text("name").primaryKey(),
    version: integer("version").notNull().default(1),
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
});
