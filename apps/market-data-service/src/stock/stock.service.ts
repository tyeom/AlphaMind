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

export interface CollectionStatus {
  collecting: boolean;
  progress: { done: number; total: number } | null;
  lastCompletedAt: string | null;
}

@Injectable()
export class StockService implements OnModuleInit {
  private readonly logger = new Logger(StockService.name);

  private static readonly CACHE_KEY_STOCKS = 'stocks:all';
  private static readonly CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000; // 10일

  private _collecting = false;
  private _progress: { done: number; total: number } | null = null;
  private _lastCompletedAt: string | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly yahooFinanceService: YahooFinanceService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  getCollectionStatus(): CollectionStatus {
    return {
      collecting: this._collecting,
      progress: this._progress,
      lastCompletedAt: this._lastCompletedAt,
    };
  }

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

  async searchStocks(query: string, limit = 20): Promise<Stock[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
    const results = await this.em.find(
      Stock,
      {
        $or: [
          { code: { $like: `${normalized}%` } },
          { name: { $ilike: `%${normalized}%` } },
        ],
      },
      { orderBy: { code: 'ASC' }, limit: safeLimit },
    );

    const lowerQuery = normalized.toLowerCase();
    return results.sort((a, b) => {
      const score = (stock: Stock) => {
        const code = stock.code.toLowerCase();
        const name = stock.name.toLowerCase();
        if (code === lowerQuery) return 0;
        if (name === lowerQuery) return 1;
        if (code.startsWith(lowerQuery)) return 2;
        if (name.startsWith(lowerQuery)) return 3;
        return 4;
      };

      const scoreDiff = score(a) - score(b);
      if (scoreDiff !== 0) return scoreDiff;
      return a.code.localeCompare(b.code);
    });
  }

  async onModuleInit() {
    const krxCodes = this.loadKrxCodes();
    const krxCodeSet = new Set(krxCodes.map((k) => k.code));

    // savepoint가 있는 종목 코드 조회
    const rows = await this.em.getConnection().execute<{ code: string }[]>(
      'SELECT s.code FROM stock_collection_savepoints sp JOIN stocks s ON sp.stock_id = s.id',
    );
    const spCodeSet = new Set(rows.map((r) => r.code));
    const missingCount = krxCodes.filter((k) => !spCodeSet.has(k.code)).length;

    this.logger.log(
      `Savepoints: ${spCodeSet.size}/${krxCodeSet.size} (missing: ${missingCount})`,
    );

    // savepoint 없는 종목이 있거나, 마지막 수집일이 뒤처져 있으면 전체 수집
    const needsCatchUp = await this.needsCatchUpCollection();
    if (missingCount > 0 || needsCatchUp) {
      this.logger.log(
        `Starting full collection (missing: ${missingCount}, stale: ${needsCatchUp})...`,
      );
      this.collectAll().catch((err) =>
        this.logger.error(`Catch-up collection failed: ${err}`),
      );
      return;
    }

    this.logger.log(
      `All ${krxCodeSet.size} stocks are up-to-date. Skipping initial collection.`,
    );
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

  /**
   * 가장 최근의 KST 평일(월~금) 17:00이 지난 날짜를 반환
   * 예) 월요일 18:00 KST → 월요일, 월요일 10:00 KST → 직전 금요일, 토요일 → 금요일
   */
  private getLatestCollectionTargetDate(): Date {
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // KST = UTC+9

    const year = kstNow.getUTCFullYear();
    const month = kstNow.getUTCMonth();
    let date = kstNow.getUTCDate();
    const day = kstNow.getUTCDay(); // 0=Sun, 6=Sat
    const hours = kstNow.getUTCHours();

    if (day === 0) {
      date -= 2; // Sun → Fri
    } else if (day === 6) {
      date -= 1; // Sat → Fri
    } else if (hours < 17) {
      // 평일이지만 17시 이전 → 직전 평일
      date -= day === 1 ? 3 : 1; // Mon → Fri, 그 외 → 전날
    }

    return new Date(Date.UTC(year, month, date));
  }

  private async needsCatchUpCollection(): Promise<boolean> {
    const targetDate = this.getLatestCollectionTargetDate();
    const targetStr = targetDate.toISOString().split('T')[0];

    const rows = await this.em.getConnection().execute<{ max_date: string }[]>(
      `SELECT MAX(last_collected_date)::text AS max_date FROM stock_collection_savepoints`,
    );

    const maxDateStr = rows[0]?.max_date;
    if (!maxDateStr) return true;

    const lastCollected = new Date(maxDateStr + 'T00:00:00Z');

    if (lastCollected < targetDate) {
      this.logger.log(
        `Savepoint check: last collected ${maxDateStr}, target ${targetStr} → catch-up needed`,
      );
      return true;
    }

    this.logger.log(
      `Savepoint check: last collected ${maxDateStr}, target ${targetStr} → up-to-date`,
    );
    return false;
  }

  private getThreeMonthsAgo(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, now.getUTCDate()),
    );
  }

  private getNextTradingDate(date: Date): Date {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay();
    if (day === 6) d.setUTCDate(d.getUTCDate() + 2); // Sat → Mon
    else if (day === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon
    return d;
  }

  async collectAll(): Promise<void> {
    const startTime = Date.now();
    const krxCodes = this.loadKrxCodes();
    const sectorMap = this.loadSectorMap();

    this._collecting = true;
    this._progress = { done: 0, total: krxCodes.length };

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
      this._progress = { done: successCount + failCount, total: krxCodes.length };
    }

    this._collecting = false;
    this._progress = null;
    this._lastCompletedAt = new Date().toISOString();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.log(
      `=== Stock data collection FINISHED (success: ${successCount}, fail: ${failCount}, elapsed: ${elapsed}s) ===`,
    );
  }

  private async collectSubset(targets: KrxCode[], sectorMap: SectorMap): Promise<void> {
    const startTime = Date.now();

    this._collecting = true;
    this._progress = { done: 0, total: targets.length };

    this.logger.log(`=== Subset collection STARTED (${targets.length} stocks) ===`);

    let successCount = 0;
    let failCount = 0;

    for (const target of targets) {
      try {
        await this.collectStock(target.code, target.name, sectorMap[target.code]);
        successCount++;
      } catch (error) {
        failCount++;
        this.logger.error(`Failed to collect ${target.code} ${target.name}: ${error}`);
      }
      this._progress = { done: successCount + failCount, total: targets.length };
    }

    this._collecting = false;
    this._progress = null;
    this._lastCompletedAt = new Date().toISOString();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.log(
      `=== Subset collection FINISHED (success: ${successCount}, fail: ${failCount}, elapsed: ${elapsed}s) ===`,
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

    // 주말 최적화: fetchFrom~now 사이에 거래일이 없으면 스킵
    const nextTradingDay = this.getNextTradingDate(fetchFrom);
    const todayDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (nextTradingDay > todayDate) {
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
