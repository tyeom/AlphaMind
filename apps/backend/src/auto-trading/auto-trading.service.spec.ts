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
      create: jest.fn(),
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

    return { service, em };
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
      enteredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      autoPausePending: false,
    } as AutoTradingSessionEntity;

    jest.spyOn(service as any, 'executeSell').mockResolvedValue(undefined);

    const sold = await (service as any).evaluateAndExecuteSell(session, 101);

    expect(sold).toBe(true);
    expect((service as any).executeSell).toHaveBeenCalledWith(
      session,
      101,
      '최대 보유기간 7일 도달 (1.0%)',
    );
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
});
