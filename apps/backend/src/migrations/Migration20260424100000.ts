import { Migration } from '@mikro-orm/migrations';

export class Migration20260424100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        alter column "take_profit_pct" set default 2.5;

      alter table "auto_trading_sessions"
        add column "max_holding_days" int not null default 7,
        add column "entered_at" timestamptz null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "max_holding_days",
        drop column "entered_at";

      alter table "auto_trading_sessions"
        alter column "take_profit_pct" set default 5;
    `);
  }
}
