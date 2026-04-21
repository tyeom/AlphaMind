import { Migration } from '@mikro-orm/migrations';

export class Migration20260421200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create unique index "auto_trading_sessions_user_stock_active_uniq"
        on "auto_trading_sessions" ("user_id", "stock_code")
        where "status" = 'active';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "auto_trading_sessions_user_stock_active_uniq";`,
    );
  }
}
