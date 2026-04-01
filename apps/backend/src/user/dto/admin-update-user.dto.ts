import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@alpha-mind/common';

export class AdminUpdateUserDto {
  @ApiPropertyOptional({ example: 'john@example.com', description: '이메일' })
  email?: string;

  @ApiPropertyOptional({ example: '홍길동', description: '이름' })
  name?: string;

  @ApiPropertyOptional({
    example: 'newpassword123',
    description: '변경할 비밀번호',
  })
  password?: string;

  @ApiPropertyOptional({
    enum: UserRole,
    example: UserRole.USER,
    description: '사용자 역할',
  })
  role?: UserRole;
}
