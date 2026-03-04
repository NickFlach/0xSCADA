/**
 * Security middleware
 */
import type { Request, Response, NextFunction } from 'express';

export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Relaxed CSP in dev for Vite HMR + inline scripts/styles
  if (process.env.NODE_ENV === 'development') {
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws://localhost:* wss://localhost:*");
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'self'");
  }
  next();
};

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export const rateLimit = (config: RateLimitConfig) => {
  const requests = new Map<string, number[]>();
  
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    // Get existing requests for this IP
    const ipRequests = requests.get(ip) || [];
    
    // Filter out old requests
    const recentRequests = ipRequests.filter(time => time > windowStart);
    
    if (recentRequests.length >= config.maxRequests) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    
    // Add this request
    recentRequests.push(now);
    requests.set(ip, recentRequests);
    
    next();
  };
};