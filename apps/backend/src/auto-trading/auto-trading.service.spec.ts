import { EntityManager } from '@mikro-orm/postgresql';
import { ClientProxy } from '@nestjs/microservices';
import { AutoTradingService } from './auto-trading.service';
import {
  AutoTradingSessionEntity,
  SessionStatus,
} from './entities/auto-trading-session.entity';

describe('AutoTradingService', () => {
  const createService = () => {
    const em = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      flush: jest.fn(),
    } as unknown as EntityManager & {
      find: jest.Mock;
      findOne: jest.Mock;
      count: jest.Mock;
      flush: jest.Mock;
    };

    const kisOrderService = {
      orderCash: jest.fn(),
      recordExecutionNotification: jest.fn(),
      markOrderRejected: jest.fn(),
    };
    const kisWsService = {
      ensureOrderNotificationsSubscribed: jest.fn().mockResolvedValue(true),
      notification$: { subscribe: jest.fn() },
      execution$: { subscribe: jest.fn() },
      subscriptionResult$: { subscribe: jest.fn() },
      unsubscribeOrderNotifications: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      isOrderNotificationsSubscribed: jest.fn().mockReturnValue(true),
      getOrderNotificationSubscriptionError: jest.fn(),
    };
    const kisQuotationService = {
      getCurrentPrice: jest.fn(),
      getDailyPrice: jest.fn(),
    };
    const kisInquiryService = {
      getBalance: jest.fn(),
    };
    const notificationService = {
      create: jest.fn().mockResolvedValue({}),
    };
    const marketDataClient = {} as ClientProxy;

    const service = new AutoTradingService(
      em,
      kisOrderService as any,
      kisWsService as any,
      kisQuotationService as any,
      kisInquiryService as any,
      notificationService as any,
      marketDataClient,
    );

    return {
      service,
      em,
      kisOrderService,
      kisWsService,
      kisQuotationService,
      kisInquiryService,
    };
  };

  it('triggers auto sell immediately when latest price exceeds take profit', async () => {
    const { service, em } = createService();
    const session = {
      id: 1,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      takeProfitPct: 1.2,
      stopLossPct: -3,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    em.find.mockResolvedValue([session]);
    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);
    (service as any).activeStockCodes.add(session.stockCode);
    (service as any).latestPrices.set(session.stockCode, 103);

    await (service as any).checkSellThresholdsForStock(session.stockCode);

    expect((service as any).executeSell).toHaveBeenCalledTimes(1);
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      103,
      '자동 익절 (3.0%)',
    );
  });

  it('triggers scale-out without pausing the remaining holding when enabled', async () => {
    const { service } = createService();
    const session = {
      id: 11,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      scaleOutStage: 0,
      takeProfitPct: 2,
      stopLossPct: -3,
      maxHoldingDays: 7,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).scaleOutEnabled = true;
    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 102);

    expect(sold).toBe(true);
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      102,
      'TP1 부분익절 (2.0%, 50%)',
      { sellQty: 5, pauseAfterSell: false, stage: 1 },
    );
  });

  it('does not fall back to the legacy TP line for a scaled-out runner', async () => {
    const { service } = createService();
    const session = {
      id: 12,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 5,
      avgBuyPrice: 100,
      highestPriceAfterEntry: 103,
      scaleOutStage: 1,
      takeProfitPct: 2,
      stopLossPct: -3,
      maxHoldingDays: 7,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).scaleOutEnabled = true;
    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 103);

    expect(sold).toBe(false);
    expect((service as any).executeSell).not.toHaveBeenCalled();
  });

  it('keeps partial optimistic sells active and increments stage only after fill', async () => {
    const { service, kisOrderService, kisWsService } = createService();
    const session = {
      id: 13,
      stockCode: '005930',
      stockName: '삼성전자',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      scaleOutStage: 0,
      takeProfitPct: 2,
      stopLossPct: -3,
      autoPausePending: false,
      user: { id: 1 },
    } as AutoTradingSessionEntity;

    kisWsService.ensureOrderNotificationsSubscribed.mockResolvedValue(false);
    kisOrderService.orderCash.mockResolvedValue({
      rt_cd: '0',
      output: { ODNO: '123' },
    });
    const pauseSpy = jest
      .spyOn(service as any, 'pauseSessionAfterAutoSell')
      .mockResolvedValue(undefined);

    await (service as any).executeSell(session, 102, 'TP1 부분익절', {
      sellQty: 5,
      pauseAfterSell: false,
      stage: 1,
    });

    expect(kisOrderService.orderCash).toHaveBeenCalledWith(
      expect.objectContaining({
        quantity: 5,
        metadata: expect.objectContaining({
          pauseAfterSell: false,
          partial: true,
          stage: 1,
        }),
      }),
    );
    expect(session.holdingQty).toBe(5);
    expect(session.autoPausePending).toBe(false);
    expect(session.scaleOutStage).toBe(1);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('skips price-triggered sell checks when there is no holding', async () => {
    const { service, em } = createService();
    const session = {
      id: 2,
      stockCode: '000660',
      status: SessionStatus.ACTIVE,
      holdingQty: 0,
      avgBuyPrice: 100,
      takeProfitPct: 1.2,
      stopLossPct: -3,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    em.find.mockResolvedValue([session]);
    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);
    (service as any).activeStockCodes.add(session.stockCode);
    (service as any).latestPrices.set(session.stockCode, 103);

    await (service as any).checkSellThresholdsForStock(session.stockCode);

    expect((service as any).executeSell).not.toHaveBeenCalled();
  });

  it('triggers auto sell when max holding days has elapsed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-16T10:00:00+09:00'));

    const { service } = createService();
    const session = {
      id: 3,
      stockCode: '035420',
      status: SessionStatus.ACTIVE,
      holdingQty: 5,
      avgBuyPrice: 100,
      takeProfitPct: 2.5,
      stopLossPct: -3,
      maxHoldingDays: 7,
      enteredAt: new Date('2026-06-05T10:00:00+09:00'),
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 101);

    expect(sold).toBe(true);
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      101,
      '최대 보유기간 7거래일 도달 (1.0%)',
    );

    jest.useRealTimers();
  });

  it('does not count weekend days toward max holding days', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-08T10:00:00+09:00'));

    const { service } = createService();
    const session = {
      id: 31,
      stockCode: '035420',
      status: SessionStatus.ACTIVE,
      holdingQty: 5,
      avgBuyPrice: 100,
      takeProfitPct: 2.5,
      stopLossPct: -3,
      maxHoldingDays: 2,
      enteredAt: new Date('2026-06-05T10:00:00+09:00'),
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 101);

    expect(sold).toBe(false);
    expect((service as any).executeSell).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('triggers trailing stop after a profitable move gives back gains', async () => {
    const { service } = createService();
    // 트레일링: peak +2.5% 후 giveback 1.6% (현재 +0.85%) → 새 임계(trigger 1.8% / giveback 1.2%) 통과.
    // enteredAt 은 grace period(5분) 밖이어야 트레일링이 발동.
    const session = {
      id: 4,
      stockCode: '051910',
      status: SessionStatus.ACTIVE,
      holdingQty: 3,
      avgBuyPrice: 100,
      highestPriceAfterEntry: 102.5,
      takeProfitPct: 3,
      stopLossPct: -2,
      maxHoldingDays: 7,
      enteredAt: new Date(Date.now() - 30 * 60_000),
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 100.85);

    expect(sold).toBe(true);
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      100.85,
      '트레일링 스톱 (현재 0.8%, 최고 2.5%)',
    );
  });

  it('does not trigger trailing stop during the grace period right after entry', async () => {
    const { service } = createService();
    // 같은 가격 조건이지만 enteredAt 이 grace period(5분) 안 — 트레일링이 발동하지 않아야 한다.
    const session = {
      id: 5,
      stockCode: '051910',
      status: SessionStatus.ACTIVE,
      holdingQty: 3,
      avgBuyPrice: 100,
      highestPriceAfterEntry: 102.5,
      takeProfitPct: 3,
      stopLossPct: -2,
      maxHoldingDays: 7,
      enteredAt: new Date(Date.now() - 60_000),
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 100.85);

    expect(sold).toBe(false);
    expect((service as any).executeSell).not.toHaveBeenCalled();
  });

  it('uses REST current price for held sessions when realtime price is missing', async () => {
    const { service, em, kisQuotationService, kisInquiryService } =
      createService();
    const session = {
      id: 6,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      takeProfitPct: 2,
      stopLossPct: -3,
      maxHoldingDays: 7,
      autoPausePending: false,
      user: { id: 1 },
    } as AutoTradingSessionEntity;

    em.find.mockResolvedValueOnce([session]).mockResolvedValueOnce([]);
    kisInquiryService.getBalance.mockResolvedValue({
      items: [
        {
          pdno: session.stockCode,
          hldg_qty: '10',
          pchs_avg_pric: '100',
        },
      ],
    });
    kisQuotationService.getCurrentPrice.mockResolvedValue({ stck_prpr: '103' });
    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    await (service as any).checkSignalsAndTrade();

    expect(kisQuotationService.getCurrentPrice).toHaveBeenCalledWith(
      session.stockCode,
    );
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      103,
      '자동 익절 (3.0%)',
    );
  });

  it('re-arms an auto-sell pending session when residual holdings remain without open orders', async () => {
    const { service, em, kisInquiryService } = createService();
    const session = {
      id: 7,
      stockCode: '000660',
      status: SessionStatus.ACTIVE,
      holdingQty: 5,
      avgBuyPrice: 100,
      autoPausePending: true,
      user: { id: 1 },
    } as AutoTradingSessionEntity;

    kisInquiryService.getBalance.mockResolvedValue({
      items: [
        {
          pdno: session.stockCode,
          hldg_qty: '2',
          pchs_avg_pric: '100',
        },
      ],
    });
    em.findOne.mockResolvedValue(null);

    await (service as any).reconcilePendingAutoPauses([session]);

    expect(session.autoPausePending).toBe(false);
    expect(session.holdingQty).toBe(2);
    expect(em.flush).toHaveBeenCalled();
  });

  it('preserves scale-out state when balance sync still has real holdings', async () => {
    const { service, em } = createService();
    const session = {
      id: 8,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 5,
      avgBuyPrice: 100,
      scaleOutStage: 1,
      initialQty: 10,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    await (service as any).applyBalanceSnapshotToSessions(
      [session],
      [
        {
          pdno: session.stockCode,
          hldg_qty: '4',
          pchs_avg_pric: '100',
        },
      ],
    );

    expect(session.holdingQty).toBe(4);
    expect(session.scaleOutStage).toBe(1);
    expect(session.initialQty).toBe(10);
    expect(em.flush).toHaveBeenCalled();
  });

  it('computes first-entry buy quantity from per-position R sizing when enabled', () => {
    const { service } = createService();
    const session = {
      stockCode: '005930',
      investmentAmount: 1_000_000,
      stopLossPct: -2,
    } as AutoTradingSessionEntity;

    (service as any).rSizingEnabled = true;

    const qty = (service as any).computeBuyQuantity(
      session,
      10_000,
      400_000,
      400_000,
      false,
    );

    expect(qty).toBe(25);
  });

  it('clamps R sizing by remaining budget and keeps add-on buys on legacy sizing', () => {
    const { service } = createService();
    const session = {
      stockCode: '005930',
      investmentAmount: 1_000_000,
      stopLossPct: -0.5,
    } as AutoTradingSessionEntity;

    (service as any).rSizingEnabled = true;

    expect(
      (service as any).computeBuyQuantity(
        session,
        10_000,
        400_000,
        400_000,
        false,
      ),
    ).toBe(40);
    expect(
      (service as any).computeBuyQuantity(
        session,
        10_000,
        150_000,
        400_000,
        true,
      ),
    ).toBe(15);
  });
});
