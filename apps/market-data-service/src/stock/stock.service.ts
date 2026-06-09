import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
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

const COLLECTION_LOOKBACK_MONTHS = 6;
const DEFAULT_SURVIVORSHIP_RETAIN_DELISTED = false;
const DEFAULT_DELIST_CONFIRM_DAYS = 5;
const DEFAULT_DELISTED_RETENTION_MONTHS = 12;
const CSV_DAMAGE_MIN_RATIO = 0.5;

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
  private lastHealthyCsvCount: number | null = null;
  private survivorshipCaveatLogged = false;

  constructor(
    private readonly em: EntityManager,
    private readonly yahooFinanceService: YahooFinanceService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
  ) {}

  private getBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.configService.get<boolean | string>(key);
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fallback;
  }

  private getNumberConfig(key: string, fallback: number): number {
    const value = this.configService.get<number | string>(key);
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  getCollectionStatus(): CollectionStatus {
    return {
      collecting: this._collecting,
      progress: this._progress,
      lastCompletedAt: this._lastCompletedAt,
    };
  }

  async findAllStocks(): Promise<Stock[]> {
    const cached = await this.cacheManager.get<Stock[]>(
      StockService.CACHE_KEY_STOCKS,
    );
    if (cached) {
      return cached;
    }

    const stocks = await this.em.find(Stock, {}, { orderBy: { code: 'ASC' } });
    await this.cacheManager.set(
      StockService.CACHE_KEY_STOCKS,
      stocks,
      StockService.CACHE_TTL_MS,
    );
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
    const rows = await this.em
      .getConnection()
      .execute<
        { code: string }[]
      >('SELECT s.code FROM stock_collection_savepoints sp JOIN stocks s ON sp.stock_id = s.id');
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
  @Cron('0 0 17 * * 1-5', {
    name: 'daily-stock-collection',
    timeZone: 'Asia/Seoul',
  })
  async handleDailyCollection() {
    this.logger.log(
      '[Scheduled] Daily stock data collection triggered (KST 17:00)',
    );
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

    const rows = await this.em
      .getConnection()
      .execute<
        { max_date: string }[]
      >(`SELECT MAX(last_collected_date)::text AS max_date FROM stock_collection_savepoints`);

    const maxDateStr = rows[0]?.max_date;
    if (!maxDateStr) return true;

    const lastCollected = new Date(maxDateStr + 'T00:00:00Z');

    if (lastCollected < targetDate) {
      this.logger.log(
        `Savepoint check: last collected ${maxDateStr}, target ${targetStr} → catch-up needed`,
      );
      return true;
    }

    if (await this.needsLookbackBackfill()) {
      return true;
    }

    this.logger.log(
      `Savepoint check: last collected ${maxDateStr}, target ${targetStr} → up-to-date`,
    );
    return false;
  }

  private async needsLookbackBackfill(): Promise<boolean> {
    const lookbackDate = this.getCollectionLookbackDate();
    const acceptableStartDate = new Date(lookbackDate);
    acceptableStartDate.setUTCDate(acceptableStartDate.getUTCDate() + 7);

    const rows = await this.em
      .getConnection()
      .execute<
        { min_date: string | null }[]
      >(`SELECT MIN(date)::text AS min_date FROM stock_daily_prices`);

    const minDateStr = rows[0]?.min_date;
    if (!minDateStr) return true;

    const minDate = new Date(`${minDateStr}T00:00:00Z`);
    if (minDate > acceptableStartDate) {
      this.logger.log(
        `Stored daily prices start at ${minDateStr}; ${COLLECTION_LOOKBACK_MONTHS}-month backfill needed`,
      );
      return true;
    }

    return false;
  }

  private getCollectionLookbackDate(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - COLLECTION_LOOKBACK_MONTHS,
        now.getUTCDate(),
      ),
    );
  }

  private getNextTradingDate(date: Date): Date {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const day = d.getUTCDay();
    if (day === 6)
      d.setUTCDate(d.getUTCDate() + 2); // Sat → Mon
    else if (day === 0) d.setUTCDate(d.getUTCDate() + 1); // Sun → Mon
    return d;
  }

  async collectAll(): Promise<void> {
    const startTime = Date.now();
    const krxCodes = this.loadKrxCodes();
    const sectorMap = this.loadSectorMap();

    try {
      await this.reconcileDelistings(
        new Set(krxCodes.map((target) => target.code)),
      );
      await this.pruneExpiredDelistedPrices();
    } catch (error) {
      // 생존편향 보존 보조 로직 실패가 기존 일일 가격 수집을 막으면 안 된다.
      this.logger.warn(
        `상폐 추정 reconcile 실패 — 기존 수집은 계속 진행: ${error}`,
      );
    }

    this._collecting = true;
    this._progress = { done: 0, total: krxCodes.length };

    this.logger.log(
      `=== Stock data collection STARTED (${krxCodes.length} stocks) ===`,
    );

    let successCount = 0;
    let failCount = 0;

    for (const target of krxCodes) {
      try {
        await this.collectStock(
          target.code,
          target.name,
          sectorMap[target.code],
        );
        successCount++;
      } catch (error) {
        failCount++;
        this.logger.error(
          `Failed to collect ${target.code} ${target.name}: ${error}`,
        );
      }
      this._progress = {
        done: successCount + failCount,
        total: krxCodes.length,
      };
    }

    this._collecting = false;
    this._progress = null;
    this._lastCompletedAt = new Date().toISOString();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    this.logger.log(
      `=== Stock data collection FINISHED (success: ${successCount}, fail: ${failCount}, elapsed: ${elapsed}s) ===`,
    );
  }

  /**
   * 현재 KRX CSV에서 연속으로 사라진 종목만 전향적으로 상폐 추정한다.
   * 과거 상폐 데이터는 소급 복구할 수 없고, 약 131거래일 데이터에서는 즉효가 없으며
   * 충분한 전향 데이터가 쌓이기 전까지 백테스트는 여전히 낙관 편향될 수 있다.
   */
  private async reconcileDelistings(krxCodeSet: Set<string>): Promise<void> {
    if (
      !this.getBooleanConfig(
        'SURVIVORSHIP_RETAIN_DELISTED',
        DEFAULT_SURVIVORSHIP_RETAIN_DELISTED,
      )
    ) {
      return;
    }

    if (!this.survivorshipCaveatLogged) {
      this.logger.warn(
        '상폐 보존은 forward-only입니다. 과거 상폐는 소급 복구 불가하고 약 131거래일 구간에는 즉효가 없으며, 성과는 여전히 낙관 편향될 수 있습니다.',
      );
      this.survivorshipCaveatLogged = true;
    }

    const em = this.em.fork();
    const stocks = await em.find(Stock, {});
    const csvCount = krxCodeSet.size;
    const previousCsvCount =
      this.lastHealthyCsvCount ?? this.countLatestSeenUniverse(stocks);

    if (
      previousCsvCount > 0 &&
      csvCount < previousCsvCount * CSV_DAMAGE_MIN_RATIO
    ) {
      this.logger.warn(
        `CSV 손상 의심 — 상폐 reconcile 스킵 (현재 ${csvCount}, 직전 ${previousCsvCount}, 최소 비율 ${CSV_DAMAGE_MIN_RATIO})`,
      );
      return;
    }

    const today = this.getUtcDateOnly();
    const confirmDays = Math.max(
      1,
      Math.floor(
        this.getNumberConfig(
          'SURVIVORSHIP_DELIST_CONFIRM_DAYS',
          DEFAULT_DELIST_CONFIRM_DAYS,
        ),
      ),
    );
    let markedCount = 0;
    let recoveredCount = 0;

    for (const stock of stocks) {
      if (krxCodeSet.has(stock.code)) {
        if (stock.delistedAt != null || (stock.missingFromCsvDays ?? 0) > 0) {
          recoveredCount++;
        }
        stock.lastSeenInCsvAt = today;
        stock.missingFromCsvDays = 0;
        stock.delistedAt = null;
        continue;
      }

      stock.missingFromCsvDays = (stock.missingFromCsvDays ?? 0) + 1;
      if (stock.missingFromCsvDays >= confirmDays && stock.delistedAt == null) {
        stock.delistedAt = stock.lastSeenInCsvAt ?? today;
        markedCount++;
      }
    }

    await em.flush();
    await this.cacheManager.del(StockService.CACHE_KEY_STOCKS);
    this.lastHealthyCsvCount = csvCount;

    this.logger.log(
      `상폐 CSV reconcile 완료: 현재 ${csvCount}, 신규 추정 ${markedCount}, 재등장 복구 ${recoveredCount}`,
    );
  }

  /**
   * 상폐 추정 종목 가격은 현행 6개월 정리에서 동결하고, 별도 보존 상한만 적용한다.
   */
  private async pruneExpiredDelistedPrices(): Promise<void> {
    if (
      !this.getBooleanConfig(
        'SURVIVORSHIP_RETAIN_DELISTED',
        DEFAULT_SURVIVORSHIP_RETAIN_DELISTED,
      )
    ) {
      return;
    }

    const retentionMonths = Math.max(
      1,
      Math.floor(
        this.getNumberConfig(
          'DELISTED_RETENTION_MONTHS',
          DEFAULT_DELISTED_RETENTION_MONTHS,
        ),
      ),
    );
    const retentionCutoff = new Date();
    retentionCutoff.setUTCMonth(
      retentionCutoff.getUTCMonth() - retentionMonths,
    );

    const em = this.em.fork();
    const delistedStocks = await em.find(Stock, {
      delistedAt: { $ne: null },
    });
    let deleteCount = 0;

    for (const stock of delistedStocks) {
      deleteCount += await em.nativeDelete(StockDailyPrice, {
        stock,
        date: { $lt: retentionCutoff },
      });
    }

    if (deleteCount > 0) {
      this.logger.log(
        `상폐 추정 종목 가격 ${deleteCount}건 정리 (${retentionMonths}개월 보존 상한 초과분)`,
      );
    }
  }

  private countLatestSeenUniverse(stocks: Stock[]): number {
    const seenTimes = stocks
      .map((stock) => stock.lastSeenInCsvAt?.getTime())
      .filter((time): time is number => time != null);
    if (seenTimes.length === 0) return 0;

    const latestSeenTime = Math.max(...seenTimes);
    return stocks.filter(
      (stock) => stock.lastSeenInCsvAt?.getTime() === latestSeenTime,
    ).length;
  }

  private getUtcDateOnly(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private async collectSubset(
    targets: KrxCode[],
    sectorMap: SectorMap,
  ): Promise<void> {
    const startTime = Date.now();

    this._collecting = true;
    this._progress = { done: 0, total: targets.length };

    this.logger.log(
      `=== Subset collection STARTED (${targets.length} stocks) ===`,
    );

    let successCount = 0;
    let failCount = 0;

    for (const target of targets) {
      try {
        await this.collectStock(
          target.code,
          target.name,
          sectorMap[target.code],
        );
        successCount++;
      } catch (error) {
        failCount++;
        this.logger.error(
          `Failed to collect ${target.code} ${target.name}: ${error}`,
        );
      }
      this._progress = {
        done: successCount + failCount,
        total: targets.length,
      };
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
    const lookbackDate = this.getCollectionLookbackDate();

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

    // 2) 보관 윈도우 이전 데이터 삭제
    const deleteCount = await em.nativeDelete(StockDailyPrice, {
      stock,
      date: { $lt: lookbackDate },
    });
    if (deleteCount > 0) {
      this.logger.log(
        `  ${code}: deleted ${deleteCount} records older than ${COLLECTION_LOOKBACK_MONTHS} months`,
      );
    }

    // 3) SavePoint 확인 → 이어서 수집할 시작일 결정
    let savepoint = await em.findOne(StockCollectionSavepoint, { stock });
    let fetchFrom = lookbackDate;
    const oldestDailyPrice = await em.findOne(
      StockDailyPrice,
      { stock },
      { fields: ['date'], orderBy: { date: 'ASC' } },
    );
    const oldestDate =
      oldestDailyPrice?.date instanceof Date
        ? oldestDailyPrice.date
        : oldestDailyPrice
          ? new Date(`${oldestDailyPrice.date}T00:00:00Z`)
          : null;
    const needsLookbackBackfill = !oldestDate || oldestDate > lookbackDate;

    if (savepoint && !needsLookbackBackfill) {
      // SavePoint 다음 날부터 수집
      const nextDay = new Date(savepoint.lastCollectedDate);
      nextDay.setDate(nextDay.getDate() + 1);

      if (nextDay > lookbackDate) {
        fetchFrom = nextDay;
      }
    }

    // 오늘 이후까지의 데이터는 불필요
    if (fetchFrom >= now) {
      return;
    }

    // 주말 최적화: fetchFrom~now 사이에 거래일이 없으면 스킵
    const nextTradingDay = this.getNextTradingDate(fetchFrom);
    const todayDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
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
        d.date instanceof Date
          ? d.date.toISOString().split('T')[0]
          : String(d.date),
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
      const latestCollectedDate = new Date(latestDate);
      if (!savepoint) {
        savepoint = em.create(StockCollectionSavepoint, {
          stock,
          lastCollectedDate: latestCollectedDate,
        });
        em.persist(savepoint);
      } else if (latestCollectedDate > new Date(savepoint.lastCollectedDate)) {
        savepoint.lastCollectedDate = latestCollectedDate;
      }
      await em.flush();
    }

    if (insertCount > 0) {
      this.logger.log(
        `  ${code} ${name}: ${insertCount} new records (last: ${latestDate})`,
      );
    }
  }
}
