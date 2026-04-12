import { Migration } from '@mikro-orm/migrations';

export class Migration20260407000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "add_on_buy_mode" varchar(10) not null default 'skip';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "add_on_buy_mode";
    `);
  }
}
