import { Migration } from '@mikro-orm/migrations';

export class Migration20260327100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "stock_collection_savepoints" (
        "id" serial primary key,
        "stock_id" int not null,
        "last_collected_date" date not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "stock_collection_savepoints_stock_id_unique" unique ("stock_id"),
        constraint "stock_collection_savepoints_stock_id_foreign" foreign key ("stock_id") references "stocks" ("id") on update cascade
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "stock_collection_savepoints" cascade;`);
  }
}
