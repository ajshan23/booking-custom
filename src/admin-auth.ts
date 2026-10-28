import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from './config.js';
import { digest, equalSecret } from './crypto.js';
import type { Store } from './db.js';

export const SESSION_COOKIE = 'booking_admin';
const SESSION_HOURS = 12;

function readCookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}
function writeCookie(req: Request, res: Response, value: string, maxAgeSeconds: number) {
  // Strict SameSite keeps the cookie off cross-site requests, which covers CSRF for the admin API.
  const flags = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (req.secure) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

export class AdminSessions {
  constructor(private store: Store, private config: Config) {}
  credentialsMatch(username: string, password: string): boolean {
    // Evaluate both comparisons so a wrong username and a wrong password take the same time.
    const user = equalSecret(username, this.config.ADMIN_USERNAME);
    const pass = equalSecret(password, this.config.ADMIN_PASSWORD);
    return user && pass;
  }
  async start(req: Request, res: Response) {
    const token = randomBytes(32).toString('base64url');
    // Only the hash is stored, so a database read cannot be replayed as a login.
    await this.store.adminSessions.insertOne({ _id: digest(token), expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000) });
    writeCookie(req, res, token, SESSION_HOURS * 3600);
  }
  async valid(req: Request): Promise<boolean> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const session = await this.store.adminSessions.findOne({ _id: digest(token) });
    return Boolean(session && session.expiresAt > new Date());
  }
  async end(req: Request, res: Response) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.store.adminSessions.deleteOne({ _id: digest(token) });
    writeCookie(req, res, '', 0);
  }
}
