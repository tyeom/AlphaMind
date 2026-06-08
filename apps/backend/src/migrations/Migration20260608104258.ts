import { Migration } from '@mikro-orm/migrations';

export class Migration20260608104258 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "scale_out_stage" int not null default 0,
        add column "initial_qty" int not null default 0;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "scale_out_stage",
        drop column "initial_qty";
    `);
  }
}
