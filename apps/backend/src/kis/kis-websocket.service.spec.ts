import { KisWebSocketService } from './kis-websocket.service';

describe('KisWebSocketService', () => {
  it('parses VI and halt fields from H0STCNT0 execution payload', () => {
    const service = new KisWebSocketService(
      {} as any,
      { get: jest.fn() } as any,
    );
    const fields = Array.from({ length: 46 }, () => '');
    fields[0] = '005930';
    fields[1] = '091500';
    fields[2] = '70000';
    fields[3] = '2';
    fields[4] = '1000';
    fields[5] = '1.45';
    fields[6] = '69500';
    fields[7] = '69000';
    fields[8] = '70500';
    fields[9] = '68800';
    fields[10] = '70000';
    fields[11] = '69900';
    fields[12] = '10';
    fields[13] = '100000';
    fields[14] = '7000000000';
    fields[18] = '120.5';
    fields[21] = '1';
    fields[34] = 'X1';
    fields[35] = 'Y';
    fields[43] = '0';
    fields[45] = '65000';

    const parsed = (service as any).parseExecution(fields);

    expect(parsed).toEqual(
      expect.objectContaining({
        stockCode: '005930',
        price: 70000,
        newMkopClsCode: 'X1',
        tradingHalt: true,
        hourClsCode: '0',
        viStndPrc: 65000,
      }),
    );
  });
});
