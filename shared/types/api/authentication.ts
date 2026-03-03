/**
 * Authentication API Types
 */

import { EntityId, Timestamp } from '../core/common';

export interface LoginRequest {
  username: string;
  password: string;
  rememberMe?: boolean;
}

export interface LoginResponse {
  token: string;
  refreshToken?: string;
  expiresAt: Timestamp;
  user: AuthenticatedUser;
}

export interface AuthenticatedUser {
  id: EntityId;
  username: string;
  email?: string;
  displayName?: string;
  roles: string[];
  permissions: string[];
  lastLogin?: Timestamp;
}

export interface TokenValidationResult {
  valid: boolean;
  user?: AuthenticatedUser;
  expiresAt?: Timestamp;
  error?: string;
}