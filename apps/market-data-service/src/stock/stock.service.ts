import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Cron } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { Stock } from './entities/stock.entity';
import { StockDailyPrice } from './entities/stock-daily-price.entity';
import { StockCollectionSavepoint } from './entities/stock-collection-savepoint.entity';
import { YahooFinanceService } from '../yahoo-finance/yahoo-finance.service';
import * as fs from 'fs';
import * as path from 'path';

interface KrxCode {
  code: string;
  name: string;
}

interface SectorMap {
  [code: string]: string;
}

@Injectable()
export class StockService implements OnModuleInit {
  private readonly logger = new Logger(StockService.name);

  private static readonly CACHE_KEY_STOCKS = 'stocks:all';
  private static readonly CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10일

  constructor(
    private readonly em: EntityManager,
    private readonly yahooFinanceService: YahooFinanceService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  async findAllStocks(): Promise<Stock[]> {
    const cached = await this.cacheManager.get<Stock[]>(StockService.CACHE_KEY_STOCKS);
    if (cached) {
      return cached;
    }

    const stocks = await this.em.find(Stock, {}, { orderBy: { code: 'ASC' } });
    await this.cacheManager.set(StockService.CACHE_KEY_STOCKS, stocks, StockService.CACHE_TTL_MS);
    return stocks;
  }

  async findStockByCode(code: string): Promise<Stock> {
    const cacheKey = `stocks:${code}`;
    const cached = await this.cacheManager.get<Stock>(cacheKey);
    if (cached) {
      return cached;
    }

    const stock = await this.em.findOneOrFail(Stock, { code });
    await this.cacheManager.set(cacheKey, stock, StockService.CACHE_TTL_MS);
    return stock;
  }

  async onModuleInit() {
    const count = await this.em.count(StockDailyPrice);
    if (count === 0) {
      this.logger.log('No data found in database. Starting initial collection...');
      await this.collectAll();
    } else {
      this.logger.log(`Database already has ${count} price records. Skipping initial collection.`);
    }
  }

  // 평일(월~금) KST 17:00 에 수집
  @Cron('0 0 17 * * 1-5', { name: 'daily-stock-collection', timeZone: 'Asia/Seoul' })
  async handleDailyCollection() {
    this.logger.log('[Scheduled] Daily stock data collection triggered (KST 17:00)');
    await this.collectAll();
  }

  private loadKrxCodes(): KrxCode[] {
    const csvPath = path.resolve(__dirname, '../../data/krx_codes.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);
    return lines.map((line) => {
      const [code, name] = line.split(',');
      return { code: code.trim(), name: name.trim() };
    });
  }

  private loadSectorMap(): SectorMap {
    const csvPath = path.resolve(__dirname, '../../data/rx_sector_map.csv');
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n').slice(1);
    const map: SectorMap = {};
    for (const line of lines) {
      const match = line.match(/^([^,]+),(.+)$/);
      if (match) {
        const code = match[1].trim();
        const sector = match[2].trim().replace(/^"|"$/g, '');
        map[code] = sector;
      }
    }
    return map;
  }

  private getThreeMonthsAgo(): Date {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  async collectAll(): Promise<void> {
    const startTime = Date.now();
    const krxCodes = this.loadKrxCodes();
    const sectorMap = this.loadSectorMap();

    this.logger.log(`=== Stock data collection STARTED (${krxCodes.length} stocks) ===`);

    let successCount = 0;
    let failCount = 0;

    for (const target of krxCodes) {
      try {
        await this.collectStock(target.code, target.name, sectorMap[target.code]);
        successCount++;
      } catch (error) {
        failCount++;
        this.logger.error(`Failed to collect ${target.code} ${target.name}: ${error}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.log(
      `=== Stock data collection FINISHED (success: ${successCount}, fail: ${failCount}, elapsed: ${elapsed}s) ===`,
    );
  }

  private async collectStock(
    code: string,
    name: string,
    sector?: string,
  ): Promise<void> {
    const yahooSymbol = `${code}.KS`;
    const em = this.em.fork();
    const now = new Date();
    const threeMonthsAgo = this.getThreeMonthsAgo();

    // 1) upsert stock
    let stock = await em.findOne(Stock, { code });
    if (!stock) {
      stock = em.create(Stock, {
        code,
        name,
        sector,
        currency: 'KRW',
        exchange: 'KSC',
      });
      await em.persistAndFlush(stock);
    } else {
      stock.name = name;
      if (sector) stock.sector = sector;
      await em.flush();
    }

    // 2) 3개월 이전 데이터 삭제
    const deleteCount = await em.nativeDelete(StockDailyPrice, {
      stock,
      date: { $lt: threeMonthsAgo },
    });
    if (deleteCount > 0) {
      this.logger.log(`  ${code}: deleted ${deleteCount} records older than 3 months`);
    }

    // 3) SavePoint 확인 → 이어서 수집할 시작일 결정
    let savepoint = await em.findOne(StockCollectionSavepoint, { stock });
    let fetchFrom = threeMonthsAgo;

    if (savepoint) {
      // SavePoint 다음 날부터 수집
      const nextDay = new Date(savepoint.lastCollectedDate);
      nextDay.setDate(nextDay.getDate() + 1);

      if (nextDay > threeMonthsAgo) {
        fetchFrom = nextDay;
      }
    }

    // 오늘 이후까지의 데이터는 불필요
    if (fetchFrom >= now) {
      return;
    }

    // 4) Yahoo Finance에서 데이터 가져오기
    const chartData = await this.yahooFinanceService.getChartByPeriod(
      yahooSymbol,
      fetchFrom,
      now,
      '1d',
    );

    if (chartData.candles.length === 0) {
      return;
    }

    // 5) 중복 체크 후 신규 데이터 저장
    const existingDates = await em.find(
      StockDailyPrice,
      { stock },
      { fields: ['date'] },
    );
    const existingDateSet = new Set(
      existingDates.map((d) =>
        d.date instanceof Date ? d.date.toISOString().split('T')[0] : String(d.date),
      ),
    );

    let insertCount = 0;
    let latestDate: string | null = null;

    for (const candle of chartData.candles) {
      if (existingDateSet.has(candle.date)) continue;
      if (candle.close === null) continue;

      em.persist(
        em.create(StockDailyPrice, {
          stock,
          date: new Date(candle.date),
          open: candle.open ?? undefined,
          high: candle.high ?? undefined,
          low: candle.low ?? undefined,
          close: candle.close ?? undefined,
          volume: candle.volume ?? undefined,
          adjClose: candle.adjClose ?? undefined,
        }),
      );
      insertCount++;

      if (!latestDate || candle.date > latestDate) {
        latestDate = candle.date;
      }
    }

    await em.flush();

    // 6) SavePoint 갱신
    if (latestDate) {
      if (!savepoint) {
        savepoint = em.create(StockCollectionSavepoint, {
          stock,
          lastCollectedDate: new Date(latestDate),
        });
        em.persist(savepoint);
      } else {
        savepoint.lastCollectedDate = new Date(latestDate);
      }
      await em.flush();
    }

    if (insertCount > 0) {
      this.logger.log(`  ${code} ${name}: ${insertCount} new records (last: ${latestDate})`);
    }
  }
}
