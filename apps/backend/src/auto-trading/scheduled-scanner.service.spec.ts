import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { of, throwError } from 'rxjs';
import {
  ScanCompletedEvent,
  ScheduledScannerService,
} from './scheduled-scanner.service';
import {
  PauseReason,
  SessionStatus,
} from './entities/auto-trading-session.entity';
import { KisInquiryService } from '../kis/kis-inquiry.service';

describe('ScheduledScannerService', () => {
  const createService = (config: Record<string, unknown> = {}) => {
    const execute = jest.fn();
    const em = {
      getConnection: () => ({ execute }),
      find: jest.fn(),
      flush: jest.fn(),
    } as unknown as EntityManager & {
      find: jest.Mock;
      flush: jest.Mock;
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
    const kisInquiryService = {
      getBuyableAmount: jest.fn().mockResolvedValue({
        ord_psbl_cash: '2000000',
      }),
      getBalance: jest.fn().mockResolvedValue({
        items: [],
        summary: {
          dnca_tot_amt: '2000000',
        },
      }),
    } as unknown as KisInquiryService & {
      getBuyableAmount: jest.Mock;
      getBalance: jest.Mock;
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
      kisInquiryService,
      marketDataClient,
    );

    return {
      service,
      execute,
      em,
      configService,
      autoTradingService,
      notificationService,
      kisInquiryService,
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

  it('uses current KIS orderable cash as scheduled scan investment amount', async () => {
    const { service, execute, em, kisInquiryService, marketDataClient } =
      createService();
    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    kisInquiryService.getBuyableAmount.mockResolvedValue({
      ord_psbl_cash: '12,345,678',
    });
    marketDataClient.emit.mockReturnValue(of(undefined));

    const result = await service.triggerScan('manual');

    expect(result).toEqual({
      triggered: true,
      userId: 1,
      availableCash: 12_345_678,
    });
    expect(marketDataClient.emit).toHaveBeenCalledWith(
      'strategy.scan.request',
      expect.objectContaining({
        investmentAmount: 12_345_678,
        scanStrategy: 'scalping',
        sectorTopOneFirst: true,
      }),
    );
  });

  it('falls back to balance cash when buyable cash lookup fails', async () => {
    const { service, execute, em, kisInquiryService, marketDataClient } =
      createService();
    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    kisInquiryService.getBuyableAmount.mockRejectedValue(
      new Error('buyable failed'),
    );
    kisInquiryService.getBalance.mockResolvedValue({
      items: [],
      summary: {
        dnca_tot_amt: '3500000',
      },
    });
    marketDataClient.emit.mockReturnValue(of(undefined));

    const result = await service.triggerScan('manual');

    expect(result.availableCash).toBe(3_500_000);
    expect(marketDataClient.emit).toHaveBeenCalledWith(
      'strategy.scan.request',
      expect.objectContaining({
        investmentAmount: 3_500_000,
      }),
    );
  });

  it('does not scan or clean sessions when current cash is not positive', async () => {
    const {
      service,
      execute,
      autoTradingService,
      kisInquiryService,
      marketDataClient,
    } = createService();
    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([]);
    kisInquiryService.getBuyableAmount.mockResolvedValue({
      ord_psbl_cash: '-100',
    });

    const result = await service.triggerScan('manual');

    expect(result).toEqual({
      triggered: false,
      reason: 'insufficient_cash',
      userId: 1,
      availableCash: 0,
    });
    expect(
      autoTradingService.removeStaleScheduledScanSessions,
    ).not.toHaveBeenCalled();
    expect(marketDataClient.emit).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
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

  it('uses scan-validated maxHoldingDays (scalping exit profile) with 7-day fallback', async () => {
    const { service, execute, em, autoTradingService } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-2b',
      response: {
        scannedStocks: 2,
        eligibleStocks: 2,
        excludedStocks: 0,
        results: [
          {
            stockCode: '005930',
            stockName: '삼성전자',
            volatilityPct: 3.2,
            autoTakeProfitPct: 2.2,
            autoStopLossPct: -1.5,
            // 단타 스캘핑 — 스캔 백테스트가 exit profile 보유일(3일)로 검증한 후보
            maxHoldingDays: 3,
            bestStrategy: {
              strategyId: 'scalping',
              strategyName: '단타 스캘핑',
              variant: 'ensemble',
            },
            currentSignal: {
              direction: 'BUY',
              strength: 0.8,
              reason: 'fresh buy',
            },
          },
          {
            stockCode: '000660',
            stockName: 'SK하이닉스',
            volatilityPct: 2.8,
            autoTakeProfitPct: 4.0,
            autoStopLossPct: -3.5,
            // 구버전 market-data 응답 — maxHoldingDays 없음 → 기존 7일 fallback
            bestStrategy: {
              strategyId: 'day-trading',
              strategyName: '일간 모멘텀 통합 전략',
            },
            currentSignal: {
              direction: 'BUY',
              strength: 0.75,
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
      { stockCode: '000660' },
    ]);

    await service.handleScanCompleted(event);

    const sessions =
      autoTradingService.startSessions.mock.calls[0][1].sessions;
    const scalping = sessions.find(
      (s: { stockCode: string }) => s.stockCode === '005930',
    );
    const legacy = sessions.find(
      (s: { stockCode: string }) => s.stockCode === '000660',
    );
    expect(scalping.maxHoldingDays).toBe(3);
    expect(scalping.takeProfitPct).toBe(2.2);
    expect(scalping.stopLossPct).toBe(-1.5);
    expect(legacy.maxHoldingDays).toBe(7);
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
    const {
      service,
      execute,
      em,
      autoTradingService,
      kisInquiryService,
    } = createService({
      REGIME_SCALING_ENABLED: true,
      REGIME_MIN_HOLDINGS_FLOOR: 3,
      REGIME_AMOUNT_FLOOR: 0.4,
    });
    kisInquiryService.getBuyableAmount.mockResolvedValue({
      ord_psbl_cash: '3000000',
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

  it('distributes current cash across resumed and new sessions without exceeding the balance', async () => {
    const { service, execute, em, autoTradingService, kisInquiryService } =
      createService();
    const pausedSession = {
      id: 10,
      stockCode: 'AAA',
      stockName: 'AAA',
      investmentAmount: 1_000_000,
      status: SessionStatus.PAUSED,
      pauseReason: PauseReason.AUTO_SELL,
      scheduledScan: true,
    };
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-budget',
      response: {
        scannedStocks: 2,
        eligibleStocks: 2,
        excludedStocks: 0,
        results: [scanCandidate('AAA', 0.9, 3), scanCandidate('BBB', 0.8, 3)],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([pausedSession]);
    kisInquiryService.getBuyableAmount.mockResolvedValue({
      ord_psbl_cash: '1000000',
    });
    autoTradingService.startSessions.mockResolvedValue([{ stockCode: 'BBB' }]);

    await service.handleScanCompleted(event);

    const startedSessions =
      autoTradingService.startSessions.mock.calls[0][1].sessions;
    expect(pausedSession.investmentAmount).toBe(500_000);
    expect(startedSessions[0].investmentAmount).toBe(500_000);
    expect(
      pausedSession.investmentAmount + startedSessions[0].investmentAmount,
    ).toBe(1_000_000);
    expect(autoTradingService.resumeSession).toHaveBeenCalledWith(10, 1);
  });

  it('keeps only candidates that can buy at least one share with current cash', async () => {
    const { service, execute, em, autoTradingService, kisInquiryService } =
      createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-affordable',
      response: {
        scannedStocks: 3,
        eligibleStocks: 3,
        excludedStocks: 0,
        results: [
          scalpingCandidate('EXPENSIVE', 0.95, 300_000),
          scalpingCandidate('MID', 0.9, 100_000),
          scalpingCandidate('CHEAP', 0.85, 50_000),
        ],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    kisInquiryService.getBuyableAmount.mockResolvedValue({
      ord_psbl_cash: '500000',
    });
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: 'MID' },
      { stockCode: 'CHEAP' },
    ]);

    await service.handleScanCompleted(event);

    const sessions = autoTradingService.startSessions.mock.calls[0][1].sessions;
    expect(sessions.map((session: any) => session.stockCode)).toEqual([
      'MID',
      'CHEAP',
    ]);
    expect(sessions.map((session: any) => session.investmentAmount)).toEqual([
      300_000, 200_000,
    ]);
    expect(
      sessions.reduce(
        (sum: number, session: any) => sum + session.investmentAmount,
        0,
      ),
    ).toBe(500_000);
  });

  it('registers profitable scalping watchlist fallbacks without a current BUY signal', async () => {
    const { service, execute, em, autoTradingService } = createService();
    const candidate: any = scalpingCandidate('WAIT', 0, 50_000);
    candidate.watchlistFallback = true;
    candidate.currentSignal = {
      direction: 'NEUTRAL',
      strength: 0,
      reason: '최근 BUY 신호 대기',
    };
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-watchlist',
      response: {
        scannedStocks: 1,
        eligibleStocks: 1,
        excludedStocks: 0,
        results: [candidate],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    autoTradingService.startSessions.mockResolvedValue([{ stockCode: 'WAIT' }]);

    await service.handleScanCompleted(event);

    expect(autoTradingService.startSessions).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        entryMode: 'monitor',
        sessions: [
          expect.objectContaining({
            stockCode: 'WAIT',
            strategyId: 'scalping',
          }),
        ],
      }),
    );
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

function scalpingCandidate(
  stockCode: string,
  strength: number,
  latestPrice: number,
) {
  return {
    ...scanCandidate(stockCode, strength, 3),
    latestPrice,
    bestStrategy: {
      strategyId: 'scalping',
      strategyName: '단타 스캘핑',
      variant: 'ensemble',
    },
  };
}
