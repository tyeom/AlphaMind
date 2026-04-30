import { Migration } from '@mikro-orm/migrations';

export class Migration20260430000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        alter column "take_profit_pct" set default 2.0,
        alter column "stop_loss_pct" set default -2.0,
        add column "highest_price_after_entry" float not null default 0;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        alter column "take_profit_pct" set default 2.5,
        alter column "stop_loss_pct" set default -3,
        drop column "highest_price_after_entry";
    `);
  }
}
