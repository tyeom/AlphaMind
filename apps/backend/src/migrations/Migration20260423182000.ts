import { Migration } from '@mikro-orm/migrations';

export class Migration20260423182000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "trade_daily_summaries" add column "has_balance_snapshot" boolean not null default true;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "trade_daily_summaries" drop column if exists "has_balance_snapshot";`,
    );
  }
}
