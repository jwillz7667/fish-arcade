import { createHash } from 'node:crypto';

import { DependencyUnavailableError, ErrorCode } from '@reef/errors';
import { describe, expect, it, vi } from 'vitest';

import { TurnstileVerifier } from './bot/turnstile-verifier.js';
import { MailpitEmailSender, MailpitSmsSender } from './messaging/mailpit-sender.js';
import { accountExistsMessage, otpMessage } from './messaging/message-sender.js';
import {
  DisabledBreachedPasswordChecker,
  HibpBreachedPasswordChecker,
} from './password/breached-password-checker.js';

type FetchArgs = Parameters<typeof fetch>;
const respond = (body: string | object, status = 200) =>
  vi.fn<(...args: FetchArgs) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    ),
  );
const failing = () =>
  vi.fn<(...args: FetchArgs) => Promise<Response>>(() =>
    Promise.reject(new TypeError('fetch failed')),
  );

const href = (input: FetchArgs[0] | undefined): string =>
  input instanceof Request ? input.url : String(input);
const bodyOf = (init: FetchArgs[1]): string => (typeof init?.body === 'string' ? init.body : '');

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex').toUpperCase();

describe('HibpBreachedPasswordChecker', () => {
  const password = 'tidal-anemone-lantern-42';
  const suffix = sha1(password).slice(5);

  it('sends only the 5-character prefix, with padding requested', async () => {
    const fetchFn = respond('');

    await new HibpBreachedPasswordChecker(fetchFn).isBreached(password);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(href(url)).toBe(`https://api.pwnedpasswords.com/range/${sha1(password).slice(0, 5)}`);
    expect(href(url)).not.toContain(suffix);
    expect(new Headers(init?.headers).get('add-padding')).toBe('true');
  });

  it('reports a breached password', async () => {
    const checker = new HibpBreachedPasswordChecker(
      respond(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:42`),
    );

    expect(await checker.isBreached(password)).toBe(true);
  });

  it('ignores padding rows with a count of zero', async () => {
    const checker = new HibpBreachedPasswordChecker(respond(`${suffix}:0`));

    expect(await checker.isBreached(password)).toBe(false);
  });

  it('fails closed when HIBP errors or is unreachable', async () => {
    await expect(
      new HibpBreachedPasswordChecker(respond('', 503)).isBreached(password),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(
      new HibpBreachedPasswordChecker(failing()).isBreached(password),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it('accepts everything when disabled', async () => {
    expect(await new DisabledBreachedPasswordChecker().isBreached()).toBe(false);
  });
});

describe('TurnstileVerifier', () => {
  it('posts the secret, token, and IP to siteverify and accepts success', async () => {
    const fetchFn = respond({ success: true, action: 'signup' });

    await new TurnstileVerifier('secret-1', fetchFn).verify('token-1', '203.0.113.9');

    const body = fetchFn.mock.calls[0]?.[1]?.body;
    expect(body instanceof URLSearchParams ? Object.fromEntries(body) : body).toMatchObject({
      secret: 'secret-1',
      response: 'token-1',
      remoteip: '203.0.113.9',
    });
  });

  it.each([
    [{ success: false, 'error-codes': ['timeout-or-duplicate'] }],
    [{ success: true, action: 'login' }],
  ])('rejects %j', async (reply) => {
    const verify = new TurnstileVerifier('secret', respond(reply)).verify('token', null);

    await expect(verify).rejects.toMatchObject({
      code: ErrorCode.BOT_CHECK_FAILED,
      httpStatus: 403,
    });
  });

  it('accepts test-mode replies with no action', async () => {
    await expect(
      new TurnstileVerifier('secret', respond({ success: true })).verify('t', null),
    ).resolves.toBeUndefined();
  });

  it('fails closed on network errors and malformed replies', async () => {
    await expect(new TurnstileVerifier('s', failing()).verify('t', null)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    await expect(
      new TurnstileVerifier('s', respond({ ok: 1 })).verify('t', null),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
    await expect(
      new TurnstileVerifier('s', respond('', 500)).verify('t', null),
    ).rejects.toBeInstanceOf(DependencyUnavailableError);
  });
});

describe('Mailpit senders', () => {
  const config = (fetchFn: typeof fetch) => ({
    baseUrl: 'http://127.0.0.1:8025',
    from: 'no-reply@reef.local',
    fetch: fetchFn,
  });

  it('sends email through the HTTP send API', async () => {
    const fetchFn = respond({ ID: 'x' });

    await new MailpitEmailSender(config(fetchFn)).send({
      to: 'p@example.com',
      subject: 'S',
      text: 'T',
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(href(url)).toBe('http://127.0.0.1:8025/api/v1/send');
    expect(JSON.parse(bodyOf(init))).toEqual({
      From: { Email: 'no-reply@reef.local' },
      To: [{ Email: 'p@example.com' }],
      Subject: 'S',
      Text: 'T',
    });
  });

  it('routes SMS to a per-number Mailpit mailbox', async () => {
    const fetchFn = respond({ ID: 'x' });

    await new MailpitSmsSender(config(fetchFn)).send({
      to: '+15551234567',
      subject: '',
      text: 'T',
    });

    expect(JSON.parse(bodyOf(fetchFn.mock.calls[0]?.[1]))).toMatchObject({
      To: [{ Email: '15551234567@sms.mailpit.local' }],
    });
  });

  it('fails closed when Mailpit is down or refuses', async () => {
    const message = { to: 'p@example.com', subject: 'S', text: 'T' };

    await expect(new MailpitEmailSender(config(failing())).send(message)).rejects.toMatchObject({
      dependency: 'email',
    });
    await expect(
      new MailpitSmsSender(config(respond('', 500))).send(message),
    ).rejects.toMatchObject({ dependency: 'sms' });
  });
});

describe('message templates', () => {
  it('put the code in the subject and body, with the expiry', () => {
    const message = otpMessage('signup', '042917', 10);

    expect([message.subject, message.text]).toEqual([
      expect.stringContaining('042917'),
      expect.stringContaining('10 minutes'),
    ]);
  });

  it('never include a code in the account-exists notice', () => {
    expect(JSON.stringify(accountExistsMessage())).not.toMatch(/\d{6}/);
  });
});
