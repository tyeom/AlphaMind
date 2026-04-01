export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

export interface User {
  id: number;
  username: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface SignInRequest {
  username: string;
  password: string;
}

export interface SignUpRequest {
  username: string;
  password: string;
  email: string;
  name: string;
}

export interface UpdateUserRequest {
  email?: string;
  name?: string;
  password?: string;
}

export interface AdminUpdateUserRequest {
  email?: string;
  name?: string;
  password?: string;
  role?: UserRole;
}
