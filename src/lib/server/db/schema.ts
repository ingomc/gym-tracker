import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

export const utilizationReadings = sqliteTable('utilization_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  weekday: integer('weekday').notNull(), // 0=Sunday, 1=Monday, ..., 6=Saturday
  hour: integer('hour').notNull(), // 0-23
  percentage: integer('percentage').notNull(), // 0-100
  level: text('level').notNull(), // LOW, MEDIUM, HIGH
}, (table) => [
  index('idx_weekday_hour').on(table.weekday, table.hour),
  index('idx_timestamp').on(table.timestamp),
]);

export type UtilizationReading = typeof utilizationReadings.$inferSelect;
export type NewUtilizationReading = typeof utilizationReadings.$inferInsert;
