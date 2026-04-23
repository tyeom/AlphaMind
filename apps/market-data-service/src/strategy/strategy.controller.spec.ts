import { EMPTY, throwError } from 'rxjs';
import { StrategyController } from './strategy.controller';

describe('StrategyController', () => {
  const createController = () => {
    const strategyService = {
      getAvailableStrategies: jest.fn(),
      analyzeAll: jest.fn(),
      analyzeDayTrading: jest.fn(),
      analyzeMeanReversion: jest.fn(),
      analyzeInfinityBot: jest.fn(),
      analyzeCandlePattern: jest.fn(),
      analyzeMomentumPower: jest.fn(),
      analyzeMomentumSurge: jest.fn(),
    };
    const backtestService = {
      scanAllStocks: jest.fn(),
      recommendStrategy: jest.fn(),
      runBacktest: jest.fn(),
    };
    const backendClient = {
      emit: jest.fn(),
    };

    const controller = new StrategyController(
      strategyService as any,
      backtestService as any,
      backendClient as any,
    );

    (controller as any).wait = jest.fn().mockResolvedValue(undefined);

    return {
      controller,
      backtestService,
      backendClient,
    };
  };

  it('retries completed event emit when RMQ reconnect is in progress', async () => {
    const { controller, backtestService, backendClient } = createController();
    backtestService.scanAllStocks.mockResolvedValue({
      scannedStocks: 10,
      eligibleStocks: 8,
      excludedStocks: 2,
      elapsedMs: 1234,
      results: [],
    });
    backendClient.emit
      .mockReturnValueOnce(
        throwError(
          () => new Error('Error: Connection lost. Trying to reconnect...'),
        ),
      )
      .mockReturnValueOnce(
        throwError(
          () => new Error('Error: Connection lost. Trying to reconnect...'),
        ),
      )
      .mockReturnValueOnce(EMPTY);

    await controller.handleScanRequest({
      userId: 2,
      requestId: 'req-1',
      excludeCodes: [],
    } as any);

    expect(backtestService.scanAllStocks).toHaveBeenCalledTimes(1);
    expect(backendClient.emit).toHaveBeenCalledTimes(3);
    expect(backendClient.emit).toHaveBeenLastCalledWith(
      'strategy.scan.completed',
      expect.objectContaining({
        userId: 2,
        requestId: 'req-1',
      }),
    );
  });

  it('emits scan.failed when scan execution throws', async () => {
    const { controller, backtestService, backendClient } = createController();
    backtestService.scanAllStocks.mockRejectedValue(new Error('scan exploded'));
    backendClient.emit.mockReturnValue(EMPTY);

    await controller.handleScanRequest({
      userId: 3,
      requestId: 'req-2',
      excludeCodes: [],
    } as any);

    expect(backendClient.emit).toHaveBeenCalledTimes(1);
    expect(backendClient.emit).toHaveBeenCalledWith(
      'strategy.scan.failed',
      expect.objectContaining({
        userId: 3,
        requestId: 'req-2',
        error: 'scan exploded',
      }),
    );
  });
});
