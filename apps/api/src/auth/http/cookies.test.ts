import { describe, expect, it } from 'vitest';

import type { IssuedTokens } from '../sessions/session-service.js';
import { clearSessionCookies, setSessionCookies, type CookieSink } from './cookies.js';

function fakeReply(): { reply: CookieSink; cookies: () => string[] } {
  let written: string[] = [];
  return {
    reply: {
      header: (_name, value) => {
        written = value;
      },
    },
    cookies: () => written,
  };
}

const now = new Date(Date.UTC(2026, 10, 20, 12));
const tokens: IssuedTokens = {
  userId: 'u',
  sessionId: 's',
  accessToken: 'eyJ.a.b',
  accessTokenExpiresAt: new Date(now.getTime() + 600_000),
  refreshToken: 'r'.repeat(43),
  refreshTokenExpiresAt: new Date(now.getTime() + 86_400_000),
  csrfToken: 'c'.repeat(64),
};

describe('session cookies', () => {
  it('writes the access, refresh, and CSRF cookies with their scopes and lifetimes', () => {
    const { reply, cookies } = fakeReply();

    setSessionCookies(reply, tokens, now);

    expect(cookies()).toEqual([
      '__Host-reef_at=eyJ.a.b; Path=/; Max-Age=600; Secure; SameSite=Lax; HttpOnly',
      `__Secure-reef_rt=${'r'.repeat(43)}; Path=/v1/auth; Max-Age=86400; Secure; SameSite=Lax; HttpOnly`,
      `__Host-reef_csrf=${'c'.repeat(64)}; Path=/; Max-Age=86400; Secure; SameSite=Lax`,
    ]);
  });

  it('expires all three on clear', () => {
    const { reply, cookies } = fakeReply();

    clearSessionCookies(reply);

    expect(cookies().map((cookie) => /Max-Age=(\d+)/.exec(cookie)?.[1])).toEqual(['0', '0', '0']);
  });

  it('refuses to write a value that could inject cookie attributes', () => {
    const { reply } = fakeReply();

    expect(() => {
      setSessionCookies(reply, { ...tokens, accessToken: 'x; Domain=evil.example' }, now);
    }).toThrow(/Refusing/);
  });
});
