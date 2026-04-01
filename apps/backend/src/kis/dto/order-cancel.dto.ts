import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OrderCancelDto {
  @ApiProperty({ example: '0000012345', description: '원주문번호' })
  orgOrderNo!: string;

  @ApiProperty({ example: '00000', description: '한국거래소전송주문조직번호' })
  krxOrgNo!: string;

  @ApiPropertyOptional({ example: true, description: '전량 취소 여부 (기본 true)' })
  allQty?: boolean;

  @ApiPropertyOptional({ example: 5, description: '취소 수량 (일부 취소 시)' })
  quantity?: number;
}
