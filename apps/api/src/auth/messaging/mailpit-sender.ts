import { DependencyUnavailableError } from '@reef/errors';

import type { MessageSender, OutboundMessage } from './message-sender.js';

const TIMEOUT_MS = 5_000;

/** Settings for the Mailpit senders. */
export interface MailpitConfig {
  /** Mailpit web/API base URL, such as `http://127.0.0.1:8025`. */
  readonly baseUrl: string;
  readonly from: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

async function post(config: MailpitConfig, dependency: string, body: unknown): Promise<void> {
  const send = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await send(new URL('/api/v1/send', config.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new DependencyUnavailableError({
      dependency,
      message: 'Mailpit unreachable',
      cause: error,
    });
  }
  if (!response.ok) {
    throw new DependencyUnavailableError({
      dependency,
      message: `Mailpit returned ${String(response.status)}`,
    });
  }
}

/**
 * Development email: delivers through Mailpit's HTTP send API, where messages are viewed in
 * its web UI. Config validation rejects it in production.
 */
export class MailpitEmailSender implements MessageSender {
  constructor(private readonly config: MailpitConfig) {}

  /**
   * @param message Email to send.
   * @throws DependencyUnavailableError when Mailpit is down or refuses the message.
   */
  async send(message: OutboundMessage): Promise<void> {
    await post(this.config, 'email', {
      From: { Email: this.config.from },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
    });
  }
}

/**
 * Development SMS: there is no SMS sandbox locally, so texts land in Mailpit as emails
 * addressed to `<digits>@sms.mailpit.local`. Config validation rejects it in production.
 */
export class MailpitSmsSender implements MessageSender {
  constructor(private readonly config: MailpitConfig) {}

  /**
   * @param message Text to send; `to` is an E.164 number.
   * @throws DependencyUnavailableError when Mailpit is down or refuses the message.
   */
  async send(message: OutboundMessage): Promise<void> {
    await post(this.config, 'sms', {
      From: { Email: this.config.from },
      To: [{ Email: `${message.to.replace(/\D/g, '')}@sms.mailpit.local` }],
      Subject: `SMS to ${message.to}`,
      Text: message.text,
    });
  }
}
