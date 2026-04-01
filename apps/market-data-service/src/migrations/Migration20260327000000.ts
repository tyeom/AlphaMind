import { Migration } from '@mikro-orm/migrations';

export class Migration20260327000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "stocks" (
        "id" serial primary key,
        "code" varchar(10) not null,
        "name" varchar(100) not null,
        "sector" varchar(100) null,
        "currency" varchar(10) not null default 'KRW',
        "exchange" varchar(20) not null default 'KSC',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "stocks_code_unique" unique ("code")
      );
    `);

    this.addSql(`
      create table "stock_daily_prices" (
        "id" serial primary key,
        "stock_id" int not null,
        "date" date not null,
        "open" double precision null,
        "high" double precision null,
        "low" double precision null,
        "close" double precision null,
        "volume" bigint null,
        "adj_close" double precision null,
        "created_at" timestamptz not null default now(),
        constraint "stock_daily_prices_stock_id_foreign" foreign key ("stock_id") references "stocks" ("id") on update cascade,
        constraint "stock_daily_prices_stock_id_date_unique" unique ("stock_id", "date")
      );
    `);

    this.addSql(`create index "stock_daily_prices_stock_id_index" on "stock_daily_prices" ("stock_id");`);
    this.addSql(`create index "stock_daily_prices_date_index" on "stock_daily_prices" ("date");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "stock_daily_prices" cascade;`);
    this.addSql(`drop table if exists "stocks" cascade;`);
  }
}
