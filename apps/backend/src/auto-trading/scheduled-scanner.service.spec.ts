import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { of, throwError } from 'rxjs';
import {
  ScanCompletedEvent,
  ScheduledScannerService,
} from './scheduled-scanner.service';
import { SessionStatus } from './entities/auto-trading-session.entity';

describe('ScheduledScannerService', () => {
  const createService = (config: Record<string, unknown> = {}) => {
    const execute = jest.fn();
    const em = {
      getConnection: () => ({ execute }),
      find: jest.fn(),
    } as unknown as EntityManager & {
      find: jest.Mock;
    };
    const configService = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        const values = {
          SCHEDULED_TRADER_USER_ID: 1,
          ...config,
        };
        if (key in values) return values[key as keyof typeof values];
        return defaultValue;
      }),
    } as unknown as ConfigService & { get: jest.Mock };
    const autoTradingService = {
      removeStaleScheduledScanSessions: jest
        .fn()
        .mockResolvedValue({ skippedDueToBalanceSyncFailure: false }),
      updateSession: jest.fn(),
      resumeSession: jest.fn(),
      startSessions: jest.fn().mockResolvedValue([]),
    };
    const notificationService = {
      create: jest.fn(),
    };
    const marketDataClient = {
      emit: jest.fn(),
      send: jest.fn().mockReturnValue(
        of({
          tpPct: 2.5,
          slPct: -2,
          source: 'default',
        }),
      ),
    } as unknown as ClientProxy & { emit: jest.Mock; send: jest.Mock };

    const service = new ScheduledScannerService(
      configService,
      em,
      autoTradingService as any,
      notificationService as any,
      marketDataClient,
    );

    return {
      service,
      execute,
      em,
      configService,
      autoTradingService,
      notificationService,
      marketDataClient,
    };
  };

  it('releases the scan lock when request publish fails', async () => {
    const { service, execute, em, marketDataClient } = createService();
    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([]);
    (em.find as jest.Mock).mockResolvedValue([]);
    marketDataClient.emit.mockReturnValue(
      throwError(() => new Error('publish failed')),
    );

    await expect(service.triggerScan('manual')).rejects.toThrow(
      'publish failed',
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain(
      'insert into scheduled_job_locks',
    );
    expect(execute.mock.calls[1][0]).toContain('update scheduled_job_locks');
    expect(execute.mock.calls[1][0]).toContain('"locked_until" = now()');
    expect(execute.mock.calls[1][0]).toContain('released:');
  });

  it('claims a completed event only once before applying scan results', async () => {
    const { service, execute, em } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-1',
      response: {
        scannedStocks: 0,
        eligibleStocks: 0,
        excludedStocks: 0,
        results: [],
      },
    };

    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (em.find as jest.Mock).mockResolvedValue([]);

    await service.handleScanCompleted(event);
    await service.handleScanCompleted(event);

    expect(em.find).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toContain('greatest(');
    expect(execute.mock.calls[2][0]).toContain(
      `and "owner" = '${event.requestId}'`,
    );
  });

  it('uses scan-validated TP/SL values when starting sessions', async () => {
    const { service, execute, em, autoTradingService } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-2',
      response: {
        scannedStocks: 1,
        eligibleStocks: 1,
        excludedStocks: 0,
        results: [
          {
            stockCode: '005930',
            stockName: '삼성전자',
            volatilityPct: 3.2,
            autoTakeProfitPct: 4.8,
            autoStopLossPct: -4.16,
            bestStrategy: {
              strategyId: 'day-trading',
              strategyName: '일간 모멘텀 통합 전략',
            },
            currentSignal: {
              direction: 'BUY',
              strength: 0.8,
              reason: 'fresh buy',
            },
          },
        ],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: '005930' },
    ]);

    await service.handleScanCompleted(event);

    expect(autoTradingService.startSessions).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            stockCode: '005930',
            takeProfitPct: 4.8,
            stopLossPct: -4.16,
          }),
        ],
      }),
    );
  });

  it('keeps legacy slot and investment amounts when Sprint3 toggles are off', async () => {
    const { service, execute, em, autoTradingService } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-off',
      response: {
        scannedStocks: 2,
        eligibleStocks: 2,
        excludedStocks: 0,
        results: [
          scanCandidate('AAA', 0.9, 2),
          scanCandidate('BBB', 0.8, 4),
        ],
        regime: {
          label: 'CRISIS',
          rawScore: 0.1,
          smoothedScore: 0.1,
          slotMultiplier: 0.1,
          amountMultiplier: 0.1,
          source: 'breadth',
          breadth: emptyBreadth(),
        },
        clusters: [{ clusterId: 1, codes: ['AAA', 'BBB'], size: 2 }],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: 'AAA' },
      { stockCode: 'BBB' },
    ]);

    await service.handleScanCompleted(event);

    const sessions = autoTradingService.startSessions.mock.calls[0][1].sessions;
    expect(sessions.map((s: any) => [s.stockCode, s.investmentAmount])).toEqual(
      [
        ['AAA', 1_333_333],
        ['BBB', 666_667],
      ],
    );
  });

  it('applies CRISIS floors to slots and base investment amount when enabled', async () => {
    const { service, execute, em, autoTradingService } = createService({
      REGIME_SCALING_ENABLED: true,
      REGIME_MIN_HOLDINGS_FLOOR: 3,
      REGIME_AMOUNT_FLOOR: 0.4,
    });
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-crisis',
      response: {
        scannedStocks: 5,
        eligibleStocks: 5,
        excludedStocks: 0,
        results: [
          scanCandidate('AAA', 0.95, 3),
          scanCandidate('BBB', 0.9, 3),
          scanCandidate('CCC', 0.85, 3),
          scanCandidate('DDD', 0.8, 3),
        ],
        regime: {
          label: 'CRISIS',
          rawScore: 0.1,
          smoothedScore: 0.1,
          slotMultiplier: 0.1,
          amountMultiplier: 0.2,
          source: 'breadth',
          breadth: emptyBreadth(),
        },
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: 'AAA' },
      { stockCode: 'BBB' },
      { stockCode: 'CCC' },
    ]);

    await service.handleScanCompleted(event);

    const sessions = autoTradingService.startSessions.mock.calls[0][1].sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions.map((s: any) => s.investmentAmount)).toEqual([
      400_000,
      400_000,
      400_000,
    ]);
  });

  it('seeds cluster counts from active holdings and gates in one adoption loop', async () => {
    const { service, execute, em, autoTradingService } = createService({
      CORRELATION_CAP_ENABLED: true,
      MAX_PER_CLUSTER: 2,
    });
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-cluster',
      response: {
        scannedStocks: 4,
        eligibleStocks: 4,
        excludedStocks: 0,
        results: [
          { ...scanCandidate('BBB', 0.95, 3), clusterId: 1, sector: 'a' },
          { ...scanCandidate('CCC', 0.9, 3), clusterId: 1, sector: 'b' },
          { ...scanCandidate('DDD', 0.85, 3), sector: 'c' },
        ],
        clusters: [{ clusterId: 1, codes: ['AAA', 'BBB', 'CCC'], size: 3 }],
      },
    };

    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([{ code: 'AAA', sector: 'z' }]);
    (em.find as jest.Mock).mockResolvedValue([
      {
        stockCode: 'AAA',
        status: SessionStatus.ACTIVE,
        scheduledScan: true,
      },
    ]);
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: 'BBB' },
      { stockCode: 'DDD' },
    ]);

    await service.handleScanCompleted(event);

    const sessions = autoTradingService.startSessions.mock.calls[0][1].sessions;
    expect(sessions.map((s: any) => s.stockCode)).toEqual(['BBB', 'DDD']);
  });
});

function emptyBreadth() {
  return {
    universeCount: 100,
    aboveSma20Ratio: 0.5,
    aboveSma60Ratio: 0.5,
    medianDailyReturnPct: 0,
    medianRet5dPct: 0,
    medianAtrPct: 4,
  };
}

function scanCandidate(stockCode: string, strength: number, volatilityPct: number) {
  return {
    stockCode,
    stockName: stockCode,
    sector: 'tech',
    volatilityPct,
    bestStrategy: {
      strategyId: 'day-trading',
      strategyName: '일간 모멘텀 통합 전략',
    },
    currentSignal: {
      direction: 'BUY',
      strength,
      reason: 'fresh buy',
    },
  };
}
