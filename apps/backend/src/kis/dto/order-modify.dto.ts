import { ApiProperty } from '@nestjs/swagger';
import { OrderDivision } from '../kis.types';

export class OrderModifyDto {
  @ApiProperty({ example: '0000012345', description: '원주문번호' })
  orgOrderNo!: string;

  @ApiProperty({ example: '00000', description: '한국거래소전송주문조직번호' })
  krxOrgNo!: string;

  @ApiProperty({
    example: '00',
    description: '주문구분',
    enum: ['00', '01', '02', '03', '04', '05', '06', '07'],
  })
  orderDvsn!: OrderDivision;

  @ApiProperty({ example: 10, description: '정정 수량' })
  quantity!: number;

  @ApiProperty({ example: 71000, description: '정정 단가' })
  price!: number;

  @ApiProperty({ example: true, description: '잔량 전부 여부' })
  allQty!: boolean;
}
