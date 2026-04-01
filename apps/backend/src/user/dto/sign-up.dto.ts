import { ApiProperty } from '@nestjs/swagger';

export class SignUpDto {
  @ApiProperty({ example: 'johndoe', description: '사용자 아이디' })
  username!: string;

  @ApiProperty({ example: 'password123', description: '비밀번호' })
  password!: string;

  @ApiProperty({ example: 'john@example.com', description: '이메일' })
  email!: string;

  @ApiProperty({ example: '홍길동', description: '이름' })
  name!: string;
}
