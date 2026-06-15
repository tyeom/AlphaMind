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

  const createRealtimeExecution = (stockCode: string, tradingHalt = true) => ({
    stockCode,
    time: '100000',
    price: 100,
    changeSign: '5',
    change: -3,
    changeRate: -3,
    weightedAvgPrice: 100,
    openPrice: 100,
    highPrice: 101,
    lowPrice: 97,
    askPrice1: 100,
    bidPrice1: 99,
    executionVolume: 10,
    cumulativeVolume: 1000,
    cumulativeAmount: 100000,
    executionStrength: 80,
    executionType: '1',
    tradingHalt,
    hourClsCode: '0',
  });

  const markViActive = (
    service: AutoTradingService,
    stockCode = '005930',
  ) => {
    (service as any).viStateTracker.updateFromExecution(
      createRealtimeExecution(stockCode, true),
    );
  };

  it('applies the resolved strategy exit profile on conflict update when exits are omitted', async () => {
    const { service, em } = createService();
    const existing = {
      id: 10,
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'day-trading',
      variant: undefined,
      takeProfitPct: 2.5,
      stopLossPct: -2.0,
      maxHoldingDays: 7,
      status: SessionStatus.ACTIVE,
    } as unknown as AutoTradingSessionEntity;

    (em as any).findOneOrFail = jest.fn().mockResolvedValue({ id: 1 });
    em.findOne.mockResolvedValue(existing);
    jest
      .spyOn(service as any, 'syncStockActivity')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'broadcastSessionUpdate')
      .mockImplementation(() => undefined);

    // 명시적 위임(delegateExits) + 전략을 scalping 으로 변경 → ensemble 프로파일 적용
    const updated = await service.startSession(1, {
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'scalping',
      variant: 'ensemble',
      investmentAmount: 1_000_000,
      onConflict: 'update',
      delegateExits: true,
    } as any);

    expect(updated.strategyId).toBe('scalping');
    expect(updated.takeProfitPct).toBe(2.2);
    expect(updated.stopLossPct).toBe(-1.5);
    expect(updated.maxHoldingDays).toBe(3);
  });

  it('resets exits to creation defaults on delegated update to a no-profile strategy', async () => {
    const { service, em } = createService();
    // 기존 세션은 scalping 프로파일 청산값 보유 — 비프로파일 전략으로 위임 갱신 시
    // 이 값이 남으면 안 되고 생성 기본값(2.0/-2.0/7일)으로 재설정돼야 한다
    const existing = {
      id: 13,
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'scalping',
      variant: 'ensemble',
      takeProfitPct: 2.2,
      stopLossPct: -1.5,
      maxHoldingDays: 3,
      status: SessionStatus.ACTIVE,
    } as unknown as AutoTradingSessionEntity;

    (em as any).findOneOrFail = jest.fn().mockResolvedValue({ id: 1 });
    em.findOne.mockResolvedValue(existing);
    jest
      .spyOn(service as any, 'syncStockActivity')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'broadcastSessionUpdate')
      .mockImplementation(() => undefined);

    const updated = await service.startSession(1, {
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'day-trading',
      variant: 'breakout',
      investmentAmount: 1_000_000,
      onConflict: 'update',
      delegateExits: true,
    } as any);

    expect(updated.strategyId).toBe('day-trading');
    expect(updated.takeProfitPct).toBe(2.0);
    expect(updated.stopLossPct).toBe(-2.0);
    expect(updated.maxHoldingDays).toBe(7);
  });

  it('keeps existing exits on conflict update when exits are omitted without delegateExits', async () => {
    const { service, em } = createService();
    const existing = {
      id: 12,
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'day-trading',
      variant: undefined,
      takeProfitPct: 2.5,
      stopLossPct: -2.0,
      maxHoldingDays: 7,
      status: SessionStatus.ACTIVE,
    } as unknown as AutoTradingSessionEntity;

    (em as any).findOneOrFail = jest.fn().mockResolvedValue({ id: 1 });
    em.findOne.mockResolvedValue(existing);
    jest
      .spyOn(service as any, 'syncStockActivity')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'broadcastSessionUpdate')
      .mockImplementation(() => undefined);

    // 위임 플래그 없는 단순 필드 생략(외부 클라이언트/재시도)은 프로파일 전략으로
    // 바뀌더라도 활성 세션의 청산값을 건드리지 않는다
    const updated = await service.startSession(1, {
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'scalping',
      variant: 'ensemble',
      investmentAmount: 1_000_000,
      onConflict: 'update',
    } as any);

    expect(updated.strategyId).toBe('scalping');
    expect(updated.takeProfitPct).toBe(2.5);
    expect(updated.stopLossPct).toBe(-2.0);
    expect(updated.maxHoldingDays).toBe(7);
  });

  it('preserves existing exits on conflict update for strategies without a profile', async () => {
    const { service, em } = createService();
    const existing = {
      id: 11,
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'scalping',
      variant: 'ensemble',
      takeProfitPct: 2.2,
      stopLossPct: -1.5,
      maxHoldingDays: 3,
      status: SessionStatus.ACTIVE,
    } as unknown as AutoTradingSessionEntity;

    (em as any).findOneOrFail = jest.fn().mockResolvedValue({ id: 1 });
    em.findOne.mockResolvedValue(existing);
    jest
      .spyOn(service as any, 'syncStockActivity')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'broadcastSessionUpdate')
      .mockImplementation(() => undefined);

    // 프로파일 없는 전략으로 변경 + 청산값 생략 → 기존값 유지 (기존 동작)
    const updated = await service.startSession(1, {
      stockCode: '005930',
      stockName: '삼성전자',
      strategyId: 'day-trading',
      variant: 'breakout',
      investmentAmount: 1_000_000,
      onConflict: 'update',
    } as any);

    expect(updated.strategyId).toBe('day-trading');
    expect(updated.takeProfitPct).toBe(2.2);
    expect(updated.stopLossPct).toBe(-1.5);
    expect(updated.maxHoldingDays).toBe(3);
  });

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
      'TP1 부분익절 (2.0%, 33%)',
      { sellQty: 3, pauseAfterSell: false, stage: 1 },
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

  it('queues REST current price refresh and skips trading when realtime price is missing', async () => {
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
    (service as any).activeStockCodes.add(session.stockCode);

    await (service as any).checkSignalsAndTrade();

    expect((service as any).pollingStockCodes.has(session.stockCode)).toBe(
      true,
    );
    expect(kisQuotationService.getCurrentPrice).toHaveBeenCalledWith(
      session.stockCode,
    );
    expect((service as any).executeSell).not.toHaveBeenCalled();
    (service as any).stopMonitoring();
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

  it('keeps the existing stop-loss call shape when VI handling is disabled', async () => {
    const { service } = createService();
    const session = {
      id: 41,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      takeProfitPct: 5,
      stopLossPct: -2,
      maxHoldingDays: 7,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).viHandlingEnabled = false;
    markViActive(service, session.stockCode);
    const sellSpy = jest
      .spyOn(service as any, 'executeSell')
      .mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 97);

    expect(sold).toBe(true);
    expect(sellSpy.mock.calls[0]).toEqual([
      session,
      97,
      '자동 손절 (-3.0%)',
    ]);
  });

  it('submits stop-loss as a limit sell while VI handling is active', async () => {
    const { service, kisOrderService } = createService();
    const session = {
      id: 42,
      stockCode: '005930',
      stockName: '삼성전자',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      takeProfitPct: 5,
      stopLossPct: -2,
      maxHoldingDays: 7,
      autoPausePending: false,
      user: { id: 1 },
    } as AutoTradingSessionEntity;

    (service as any).viHandlingEnabled = true;
    (service as any).viStoplossLimitOrder = true;
    markViActive(service, session.stockCode);
    kisOrderService.orderCash.mockResolvedValue({
      rt_cd: '0',
      output: { ODNO: 'SL-1' },
    });

    const sold = await (service as any).evaluateAndExecuteSell(session, 97);

    expect(sold).toBe(true);
    expect(kisOrderService.orderCash).toHaveBeenCalledWith(
      expect.objectContaining({
        stockCode: session.stockCode,
        orderType: 'sell',
        orderDvsn: '00',
        quantity: 10,
        price: 97,
      }),
    );
  });

  it('defers buy orders while VI handling is active', async () => {
    const { service, kisOrderService } = createService();
    const session = {
      id: 43,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 0,
      avgBuyPrice: 0,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).viHandlingEnabled = true;
    markViActive(service, session.stockCode);

    await (service as any).executeBuy(session, 100);

    expect(kisOrderService.orderCash).not.toHaveBeenCalled();
    expect((service as any).viHeldOrders.get(session.id)).toMatchObject({
      intent: 'buy',
      stockCode: session.stockCode,
    });
  });

  it('defers TP1 scale-out while VI handling is active', async () => {
    const { service } = createService();
    const session = {
      id: 44,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      scaleOutStage: 0,
      takeProfitPct: 5,
      stopLossPct: -3,
      maxHoldingDays: 7,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).viHandlingEnabled = true;
    (service as any).scaleOutEnabled = true;
    markViActive(service, session.stockCode);
    const sellSpy = jest
      .spyOn(service as any, 'executeSell')
      .mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 102);

    expect(sold).toBe(true);
    expect(sellSpy).not.toHaveBeenCalled();
    expect((service as any).viHeldOrders.get(session.id)).toMatchObject({
      intent: 'tp1-scale-out',
    });
  });

  it('defers breakeven and trailing-stop exits while VI handling is active', async () => {
    const { service } = createService();
    const breakevenSession = {
      id: 45,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      highestPriceAfterEntry: 102,
      takeProfitPct: 5,
      stopLossPct: -3,
      maxHoldingDays: 7,
      enteredAt: new Date(Date.now() - 30 * 60_000),
      autoPausePending: false,
    } as AutoTradingSessionEntity;
    const trailingSession = {
      ...breakevenSession,
      id: 46,
      stockCode: '000660',
      highestPriceAfterEntry: 102.5,
    } as AutoTradingSessionEntity;

    (service as any).viHandlingEnabled = true;
    markViActive(service, breakevenSession.stockCode);
    markViActive(service, trailingSession.stockCode);
    const sellSpy = jest
      .spyOn(service as any, 'executeSell')
      .mockResolvedValue(undefined);

    await (service as any).evaluateAndExecuteSell(breakevenSession, 100);
    await (service as any).evaluateAndExecuteSell(trailingSession, 100.85);

    expect(sellSpy).not.toHaveBeenCalled();
    expect((service as any).viHeldOrders.get(breakevenSession.id)).toMatchObject({
      intent: 'breakeven-stop',
    });
    expect((service as any).viHeldOrders.get(trailingSession.id)).toMatchObject({
      intent: 'trailing-stop',
    });
  });

  it('REST 보강 대상이어도 비-limit 구독 실패는 WebSocket 재시도를 예약한다 (회귀 방지)', () => {
    const { service } = createService();
    const svc = service as any;
    const stockCode = '005930';
    svc.activeStockCodes.add(stockCode);
    // REST 보강 대상 등록 여부와 WebSocket 구독 재시도 여부는 서로 독립이어야 한다.
    svc.pollingStockCodes.add(stockCode);

    try {
      svc.handleExecutionSubscriptionResult({
        trId: 'H0STCNT0',
        action: 'subscribe',
        trKey: stockCode,
        success: false,
        code: 'ERR',
        message: '일시적 연결 오류', // limit/초과/한도 미포함 → 비-limit 실패
      });

      // REST 보강이 등록되어 있어도 비-limit 실패는 재시도가 예약되어야 한다.
      expect(svc.subscriptionRetryTimers.has(stockCode)).toBe(true);
    } finally {
      svc.clearSubscriptionRetry(stockCode);
      svc.stopMonitoring();
    }
  });

  it('re-evaluates held sell intent against current price when VI clears', async () => {
    const { service, em } = createService();
    const session = {
      id: 47,
      stockCode: '005930',
      status: SessionStatus.ACTIVE,
      holdingQty: 10,
      avgBuyPrice: 100,
      scaleOutStage: 0,
      takeProfitPct: 5,
      stopLossPct: -3,
      maxHoldingDays: 7,
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    (service as any).scaleOutEnabled = true;
    (service as any).viHeldOrders.set(session.id, {
      sessionId: session.id,
      stockCode: session.stockCode,
      intent: 'tp1-scale-out',
      queuedAt: Date.now(),
    });
    (service as any).latestPrices.set(session.stockCode, 101);
    (service as any).latestPriceUpdatedAt.set(session.stockCode, Date.now());
    em.find.mockResolvedValue([session]);
    const sellSpy = jest
      .spyOn(service as any, 'executeSell')
      .mockResolvedValue(undefined);

    await (service as any).reevaluateHeldOrdersForStock(
      session.stockCode,
      'execution-release',
    );

    expect(sellSpy).not.toHaveBeenCalled();
    expect((service as any).viHeldOrders.has(session.id)).toBe(false);
  });

  it('schedules re-evaluation on VI release and timeout recovery', () => {
    const { service } = createService();
    const stockCode = '005930';
    const scheduleSpy = jest
      .spyOn(service as any, 'scheduleViReevaluation')
      .mockImplementation(() => undefined);

    (service as any).viHandlingEnabled = true;
    (service as any).updateViStateFromExecution(
      createRealtimeExecution(stockCode, true),
    );
    (service as any).updateViStateFromExecution(
      createRealtimeExecution(stockCode, false),
    );

    const timeoutState = (service as any).viStateTracker.updateFromExecution(
      createRealtimeExecution('000660', true),
    );
    timeoutState.activeUntil = Date.now() - 1;
    (service as any).handleViClearTimeout('000660');

    expect(scheduleSpy).toHaveBeenCalledWith(stockCode, 'execution-release');
    expect(scheduleSpy).toHaveBeenCalledWith('000660', 'timeout');
  });

  it('keeps the exchange resolver on the KRX branch for now', () => {
    const { service } = createService();

    expect((service as any).resolveExchange('005930')).toBe('KRX');
  });
});
