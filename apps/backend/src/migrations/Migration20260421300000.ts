import { Migration } from '@mikro-orm/migrations';

export class Migration20260421300000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "scheduled_scan" boolean not null default false;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "scheduled_scan";
    `);
  }
}
