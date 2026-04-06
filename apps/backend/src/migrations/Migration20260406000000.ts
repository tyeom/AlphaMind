import { Migration } from '@mikro-orm/migrations';

export class Migration20260406000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "take_profit_pct" float not null default 5,
        add column "stop_loss_pct" float not null default -3;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "take_profit_pct",
        drop column "stop_loss_pct";
    `);
  }
}
