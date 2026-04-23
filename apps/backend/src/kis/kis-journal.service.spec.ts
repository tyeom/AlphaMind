import { EntityManager } from '@mikro-orm/postgresql';
import { KisInquiryService } from './kis-inquiry.service';
import { KisJournalService } from './kis-journal.service';

describe('KisJournalService', () => {
  const createService = () => {
    const em = {
      findOne: jest.fn(),
      create: jest.fn((_entity, data) => data),
      persistAndFlush: jest.fn(),
      getReference: jest.fn((_entity, id) => ({ id })),
    } as unknown as EntityManager & {
      findOne: jest.Mock;
      create: jest.Mock;
      persistAndFlush: jest.Mock;
      getReference: jest.Mock;
    };

    const inquiryService = {
      getDailyOrders: jest.fn(),
      getBalance: jest.fn(),
      getBalanceWithRealized: jest.fn(),
    } as unknown as KisInquiryService & {
      getDailyOrders: jest.Mock;
      getBalance: jest.Mock;
      getBalanceWithRealized: jest.Mock;
    };

    const service = new KisJournalService(em, inquiryService);

    return { service, em, inquiryService };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-23T18:20:00+09:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('rejects future dates without serving cached or new data', async () => {
    const { service, em, inquiryService } = createService();

    const result = await service.getJournal(1, '20260424');

    expect(result).toMatchObject({
      date: '20260424',
      isAvailable: false,
      message: '미래 날짜의 매매 일지는 조회할 수 없습니다.',
    });
    expect(em.findOne).not.toHaveBeenCalled();
    expect(inquiryService.getDailyOrders).not.toHaveBeenCalled();
  });

  it('creates today journal when explicit date is provided and realized balance lookup fails', async () => {
    const { service, em, inquiryService } = createService();

    em.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    inquiryService.getDailyOrders.mockResolvedValue([
      {
        pdno: '005930',
        prdt_name: '삼성전자',
        tot_ccld_qty: '10',
        tot_ccld_amt: '700000',
        sll_buy_dvsn_cd: '02',
      },
    ]);
    inquiryService.getBalance.mockResolvedValue({
      items: [
        {
          pdno: '005930',
          prdt_name: '삼성전자',
          hldg_qty: '10',
          pchs_avg_pric: '70000',
          prpr: '71000',
          evlu_amt: '710000',
          evlu_pfls_amt: '10000',
          evlu_pfls_rt: '1.43',
        },
      ],
      summary: {
        dnca_tot_amt: '300000',
        pchs_amt_smtl_amt: '700000',
        evlu_amt_smtl_amt: '710000',
        evlu_pfls_smtl_amt: '10000',
      },
    });
    inquiryService.getBalanceWithRealized.mockRejectedValue(
      new Error('realized failed'),
    );

    const result = await service.getJournal(1, '20260423');

    expect(result).toMatchObject({
      date: '20260423',
      isAvailable: true,
      isPartial: false,
      totalBuyAmount: 700000,
      totalEvalAmount: 710000,
      cashBalance: 300000,
    });
    expect(result.totalProfitLossRate).toBeCloseTo(1.4285714286, 5);
    expect(em.persistAndFlush).toHaveBeenCalledTimes(1);
    expect(em.create.mock.calls[0][1]).toMatchObject({
      date: '20260423',
      hasBalanceSnapshot: true,
    });
  });

  it('refreshes today journal even when a stale zero summary already exists', async () => {
    const { service, em, inquiryService } = createService();

    em.findOne
      .mockResolvedValueOnce({
        date: '20260423',
        hasBalanceSnapshot: true,
        stockSummaries: [],
        totalBuyAmount: 0,
        totalSellAmount: 0,
        realizedProfitLoss: 0,
        totalEvalAmount: 0,
        totalPurchaseAmount: 0,
        totalEvalProfitLoss: 0,
        totalProfitLossRate: 0,
        cashBalance: 0,
      })
      .mockResolvedValueOnce({
        date: '20260423',
        hasBalanceSnapshot: true,
        stockSummaries: [],
        totalBuyAmount: 0,
        totalSellAmount: 0,
        realizedProfitLoss: 0,
        totalEvalAmount: 0,
        totalPurchaseAmount: 0,
        totalEvalProfitLoss: 0,
        totalProfitLossRate: 0,
        cashBalance: 0,
      })
      .mockResolvedValueOnce(null);

    inquiryService.getDailyOrders.mockResolvedValue([]);
    inquiryService.getBalance.mockResolvedValue({
      items: [],
      summary: {
        dnca_tot_amt: '100000',
        pchs_amt_smtl_amt: '500000',
        evlu_amt_smtl_amt: '515000',
        evlu_pfls_smtl_amt: '15000',
      },
    });
    inquiryService.getBalanceWithRealized.mockResolvedValue({
      items: [],
      summary: {},
    });

    const result = await service.getJournal(1, '20260423');

    expect(result.isAvailable).toBe(true);
    expect(result.totalEvalAmount).toBe(515000);
    expect(result.totalPurchaseAmount).toBe(500000);
    expect(result.totalEvalProfitLoss).toBe(15000);
    expect(result.totalProfitLossRate).toBeCloseTo(3, 5);
    expect(em.persistAndFlush).toHaveBeenCalledTimes(1);
  });

  it('recalculates total profit rate from stored summary values for past cached journals', async () => {
    const { service, em } = createService();

    em.findOne
      .mockResolvedValueOnce({
        date: '20260422',
        hasBalanceSnapshot: true,
        stockSummaries: [],
        totalBuyAmount: 0,
        totalSellAmount: 0,
        realizedProfitLoss: 0,
        totalEvalAmount: 515000,
        totalPurchaseAmount: 500000,
        totalEvalProfitLoss: 15000,
        totalProfitLossRate: 0,
        cashBalance: 100000,
      })
      .mockResolvedValueOnce(null);

    const result = await service.getJournal(1, '20260422');

    expect(result.isAvailable).toBe(true);
    expect(result.totalProfitLossRate).toBeCloseTo(3, 5);
    expect(em.persistAndFlush).not.toHaveBeenCalled();
  });

  it('does not persist today journal when balance lookup fails', async () => {
    const { service, em, inquiryService } = createService();

    em.findOne.mockResolvedValueOnce(null);

    inquiryService.getDailyOrders.mockResolvedValue([]);
    inquiryService.getBalance.mockRejectedValue(new Error('balance failed'));
    inquiryService.getBalanceWithRealized.mockResolvedValue({
      items: [],
      summary: {},
    });

    const result = await service.getJournal(1, '20260423');

    expect(result).toMatchObject({
      date: '20260423',
      isAvailable: false,
      message: '매매 일지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    });
    expect(em.persistAndFlush).not.toHaveBeenCalled();
  });

  it('backfills past dates from orders and persists them as partial snapshots', async () => {
    const { service, em, inquiryService } = createService();

    em.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    inquiryService.getDailyOrders.mockResolvedValue([
      {
        pdno: '000660',
        prdt_name: 'SK하이닉스',
        tot_ccld_qty: '5',
        tot_ccld_amt: '500000',
        sll_buy_dvsn_cd: '02',
      },
    ]);

    const result = await service.getJournal(1, '20260422');

    expect(result).toMatchObject({
      date: '20260422',
      isAvailable: true,
      isPartial: true,
      message:
        '과거 날짜의 매매 일지는 체결 내역 기준으로 생성되었습니다. 평가금액과 예수금은 포함되지 않습니다.',
      totalBuyAmount: 500000,
      totalEvalAmount: 0,
      cashBalance: 0,
    });
    expect(result.previousDay).toBeUndefined();
    expect(result.dayOverDayChange).toBeUndefined();
    expect(inquiryService.getBalance).not.toHaveBeenCalled();
    expect(inquiryService.getBalanceWithRealized).not.toHaveBeenCalled();
    expect(em.create.mock.calls[0][1]).toMatchObject({
      date: '20260422',
      hasBalanceSnapshot: false,
    });
    expect(em.persistAndFlush).toHaveBeenCalledTimes(1);
  });
});
