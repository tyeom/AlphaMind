import { ApiProperty } from '@nestjs/swagger';

export class SignInDto {
  @ApiProperty({ example: 'johndoe', description: '사용자 아이디' })
  username!: string;

  @ApiProperty({ example: 'password123', description: '비밀번호' })
  password!: string;
}
