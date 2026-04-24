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
    } as unknown as EntityManager & {
      find: jest.Mock;
      findOne: jest.Mock;
      count: jest.Mock;
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
});
