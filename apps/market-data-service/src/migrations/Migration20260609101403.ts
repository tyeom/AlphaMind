import { Migration } from '@mikro-orm/migrations';

export class Migration20260609101403 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "stocks"
        add column "delisted_at" date null,
        add column "missing_from_csv_days" int null default 0,
        add column "last_seen_in_csv_at" timestamptz null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "stocks"
        drop column if exists "delisted_at",
        drop column if exists "missing_from_csv_days",
        drop column if exists "last_seen_in_csv_at";
    `);
  }
}
