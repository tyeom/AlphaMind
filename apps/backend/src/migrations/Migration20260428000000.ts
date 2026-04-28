import { Migration } from '@mikro-orm/migrations';

export class Migration20260428000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "add_on_buy_count" int not null default 0;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "add_on_buy_count";
    `);
  }
}
