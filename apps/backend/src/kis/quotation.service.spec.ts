import { ConfigService } from '@nestjs/config';
import { QuotationService } from './quotation.service';
import { TossQuotationService } from './toss-quotation.service';
import { KisQuotationService } from './kis-quotation.service';
import { KisCurrentPrice } from './kis.types';
import { TossPrice } from './toss.types';

const PRICE_MAX_AGE_MS = 300_000;

describe('QuotationService', () => {
  const isoNow = () => new Date(Date.now()).toISOString();
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  const makeTossPrice = (overrides?: Partial<TossPrice>): TossPrice => ({
    symbol: '005930',
    timestamp: isoNow(),
    lastPrice: '72000',
    currency: 'KRW',
    ...overrides,
  });

  const makeKisCurrentPrice = (
    overrides?: Partial<KisCurrentPrice>,
  ): KisCurrentPrice => ({
    stck_shrn_iscd: '005930',
    hts_kor_isnm: '삼성전자(KIS)',
    stck_prpr: '71000',
    prdy_vrss: '0',
    prdy_vrss_sign: '3',
    prdy_ctrt: '0',
    stck_oprc: '71000',
    stck_hgpr: '71000',
    stck_lwpr: '71000',
    stck_mxpr: '92000',
    stck_llam: '50000',
    acml_vol: '10',
    acml_tr_pbmn: '100',
    per: '',
    pbr: '',
    eps: '',
    bps: '',
    hts_avls: '',
    hts_frgn_ehrt: '',
    iscd_stat_cls_code: '00',
    mrkt_warn_cls_code: '00',
    ...overrides,
  });

  const createService = () => {
    const toss = {
      isConfigured: jest.fn().mockReturnValue(true),
      isAvailable: jest.fn().mockReturnValue(true),
      getCurrentPrice: jest.fn().mockResolvedValue(makeTossPrice()),
      getCandles: jest.fn().mockResolvedValue([]),
      getStockInfo: jest.fn().mockResolvedValue({ name: '삼성전자' }),
    };
    const kis = {
      getCurrentPrice: jest.fn().mockResolvedValue(makeKisCurrentPrice()),
      getDailyPrice: jest.fn().mockResolvedValue([]),
    };
    const config = {
      get: jest.fn((key: string, def?: unknown) =>
        key === 'TOSS_PRICE_MAX_AGE_MS' ? PRICE_MAX_AGE_MS : def,
      ),
    };
    const service = new QuotationService(
      toss as unknown as TossQuotationService,
      kis as unknown as KisQuotationService,
      config as unknown as ConfigService,
    );
    return { service, toss, kis };
  };

  describe('getCurrentPrice stays KIS-authoritative for risk status', () => {
    it('returns KIS status codes verbatim (51 관리종목 preserved) without calling Toss', async () => {
      const { service, toss, kis } = createService();
      kis.getCurrentPrice.mockResolvedValue(
        makeKisCurrentPrice({ iscd_stat_cls_code: '51' }),
      );

      const result = await service.getCurrentPrice('005930');

      expect(result.iscd_stat_cls_code).toBe('51');
      expect(kis.getCurrentPrice).toHaveBeenCalledWith('005930');
      expect(toss.getCurrentPrice).not.toHaveBeenCalled();
    });

    it('preserves 54 (투자주의) which Toss cannot represent', async () => {
      const { service, kis } = createService();
      kis.getCurrentPrice.mockResolvedValue(
        makeKisCurrentPrice({ iscd_stat_cls_code: '54' }),
      );

      const result = await service.getCurrentPrice('005930');

      expect(result.iscd_stat_cls_code).toBe('54');
    });
  });

  describe('getLastPrice freshness', () => {
    it('uses a fresh Toss price', async () => {
      const { service, toss, kis } = createService();
      const price = await service.getLastPrice('005930');
      expect(price).toBe(72000);
      expect(toss.getCurrentPrice).toHaveBeenCalledWith('005930');
      expect(kis.getCurrentPrice).not.toHaveBeenCalled();
    });

    it('falls back to KIS when Toss timestamp is null (no execution)', async () => {
      const { service, toss, kis } = createService();
      toss.getCurrentPrice.mockResolvedValue(
        makeTossPrice({ timestamp: null }),
      );
      const price = await service.getLastPrice('005930');
      expect(kis.getCurrentPrice).toHaveBeenCalledWith('005930');
      expect(price).toBe(71000);
    });

    it('falls back to KIS when Toss execution time is stale', async () => {
      const { service, toss, kis } = createService();
      toss.getCurrentPrice.mockResolvedValue(
        makeTossPrice({ timestamp: isoAgo(PRICE_MAX_AGE_MS + 60_000) }),
      );
      const price = await service.getLastPrice('005930');
      expect(kis.getCurrentPrice).toHaveBeenCalledWith('005930');
      expect(price).toBe(71000);
    });

    it('falls back to KIS when Toss throws', async () => {
      const { service, toss, kis } = createService();
      toss.getCurrentPrice.mockRejectedValue(new Error('down'));
      const price = await service.getLastPrice('005930');
      expect(kis.getCurrentPrice).toHaveBeenCalledWith('005930');
      expect(price).toBe(71000);
    });

    it('uses KIS directly when Toss is not available (unconfigured or breaker open)', async () => {
      const { service, toss, kis } = createService();
      toss.isAvailable.mockReturnValue(false);
      await service.getLastPrice('005930');
      expect(toss.getCurrentPrice).not.toHaveBeenCalled();
      expect(kis.getCurrentPrice).toHaveBeenCalledWith('005930');
    });
  });

  describe('getDailyPrice', () => {
    it('maps Toss 1d candles newest-first with computed change rate', async () => {
      const { service, toss } = createService();
      toss.getCandles.mockResolvedValue([
        {
          timestamp: '2026-03-24T09:00:00+09:00',
          openPrice: '100',
          highPrice: '105',
          lowPrice: '99',
          closePrice: '100',
          volume: '1000',
          currency: 'KRW',
        },
        {
          timestamp: '2026-03-25T09:00:00+09:00',
          openPrice: '101',
          highPrice: '110',
          lowPrice: '100',
          closePrice: '110',
          volume: '2000',
          currency: 'KRW',
        },
      ]);

      const result = await service.getDailyPrice('005930', 'D');

      expect(result[0].stck_bsop_date).toBe('20260325');
      expect(result[0].stck_clpr).toBe('110');
      expect(result[0].prdy_ctrt).toBe('10.00');
      expect(result[1].stck_bsop_date).toBe('20260324');
    });

    it('falls back to KIS for unsupported periods (W/M/Y)', async () => {
      const { service, toss, kis } = createService();
      await service.getDailyPrice('005930', 'M');
      expect(toss.getCandles).not.toHaveBeenCalled();
      expect(kis.getDailyPrice).toHaveBeenCalledWith('005930', 'M', true);
    });
  });

  describe('getStockName', () => {
    it('uses Toss stock info, falling back to KIS name', async () => {
      const { service, toss, kis } = createService();
      expect(await service.getStockName('005930')).toBe('삼성전자');

      toss.getStockInfo.mockRejectedValue(new Error('down'));
      expect(await service.getStockName('005930')).toBe('삼성전자(KIS)');
      expect(kis.getCurrentPrice).toHaveBeenCalled();
    });
  });
});
