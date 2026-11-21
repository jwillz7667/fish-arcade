import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { RequestContext } from '@reef/logger';
import type { IncomingMessage } from 'node:http';

import { createValidationPipe } from '../http/validation.js';
import { AppModule, type AppDependencies } from './app.module.js';
import { NestPinoLogger } from './nest-logger.js';

/** Input to {@link createApp}. */
export interface CreateAppOptions extends AppDependencies {
  /** Request scope the logger reads `requestId` from. */
  readonly requestContext: RequestContext;
}

/** API path prefix (spec §12). */
export const API_PREFIX = 'v1';

const BODY_LIMIT_BYTES = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

// Accept a well-formed upstream request ID (from the load balancer) so traces join up;
// otherwise mint one.
function requestIdFor(request: IncomingMessage): string {
  const incoming = request.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Builds the API (playbook Step 5): `/v1` prefix, strict helmet, CORS allowlist, request IDs
 * in every log line and response, global validation, rate limiting, idempotency for money
 * routes, uniform error bodies, and OpenAPI outside production. Does not listen.
 *
 * @param options Resources, env, and request context.
 * @returns An initialised Nest application.
 */
export async function createApp(options: CreateAppOptions): Promise<NestFastifyApplication> {
  const { env, logger, requestContext } = options;
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    // Trust exactly TRUST_PROXY_HOPS proxies, so request.ip is the client and cannot be spoofed
    // with X-Forwarded-For beyond that.
    trustProxy: (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS,
    genReqId: requestIdFor,
    // New connections get 503 while draining; idle keep-alive sockets close at once.
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(options),
    adapter,
    {
      logger: new NestPinoLogger(logger),
      abortOnError: false,
    },
  );

  const fastify = app.getHttpAdapter().getInstance();
  let isClosing = false;
  fastify.addHook('preClose', (done) => {
    isClosing = true;
    done();
  });
  // While draining, ask clients to drop keep-alive sockets after their response, so close()
  // completes as soon as in-flight requests finish instead of waiting out keep-alive timeouts.
  fastify.addHook('onSend', (_request, reply, payload, done) => {
    if (isClosing) void reply.header('connection', 'close');
    done(null, payload);
  });
  fastify.addHook('onRequest', (request, reply, done) => {
    requestContext.enter({ requestId: request.id });
    void reply.header('x-request-id', request.id);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: [
      'content-type',
      'authorization',
      'idempotency-key',
      'x-csrf-token',
      'x-request-id',
    ],
    exposedHeaders: ['x-request-id', 'retry-after', 'idempotent-replayed'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(createValidationPipe());

  if (env.NODE_ENV !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Reef API').setVersion(API_PREFIX).build(),
    );
    fastify.get(`/${API_PREFIX}/openapi.json`, () => document);
  }

  await app.init();
  return app;
}
