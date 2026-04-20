import { Migration } from '@mikro-orm/migrations';

export class Migration20260421000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "trade_histories"
        add column "executed_quantity" int not null default 0,
        add column "executed_amount" numeric(15,0) not null default 0,
        add column "last_executed_at" timestamptz null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "trade_histories"
        drop column "executed_quantity",
        drop column "executed_amount",
        drop column "last_executed_at";
    `);
  }
}
