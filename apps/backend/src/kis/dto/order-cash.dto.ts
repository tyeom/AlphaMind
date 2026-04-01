import { ApiProperty } from '@nestjs/swagger';
import { OrderDivision } from '../kis.types';

export class OrderCashDto {
  @ApiProperty({ example: '005930', description: '종목코드 (6자리)' })
  stockCode!: string;

  @ApiProperty({
    example: '00',
    description: '주문구분 (00: 지정가, 01: 시장가, 02: 조건부지정가 등)',
    enum: ['00', '01', '02', '03', '04', '05', '06', '07'],
  })
  orderDvsn!: OrderDivision;

  @ApiProperty({ example: 10, description: '주문 수량' })
  quantity!: number;

  @ApiProperty({ example: 70000, description: '주문 단가 (시장가일 때 0)' })
  price!: number;
}
