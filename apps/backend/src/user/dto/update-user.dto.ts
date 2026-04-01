import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'john@example.com', description: '이메일' })
  email?: string;

  @ApiPropertyOptional({ example: '홍길동', description: '이름' })
  name?: string;

  @ApiPropertyOptional({
    example: 'newpassword123',
    description: '변경할 비밀번호',
  })
  password?: string;
}
