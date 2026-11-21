import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Minimal CBOR encoder: the subset WebAuthn attestation objects use. Tests only. */
type CborValue = number | string | Uint8Array | ReadonlyMap<CborValue, CborValue>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const buffer = Buffer.alloc(3);
  buffer[0] = (major << 5) | 25;
  buffer.writeUInt16BE(length, 1);
  return buffer;
}

function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();
const b64url = (data: Buffer | Uint8Array): string => Buffer.from(data).toString('base64url');

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/**
 * A software passkey (ES256) that answers WebAuthn ceremonies the way a browser plus platform
 * authenticator would, so passkey flows can be tested end to end without a browser.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  #counter = 0;
  readonly #privateKey: KeyObject;
  readonly #cosePublicKey: Buffer;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.#cosePublicKey = cbor(
      new Map<CborValue, CborValue>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(String(jwk.x), 'base64url')],
        [-3, Buffer.from(String(jwk.y), 'base64url')],
      ]),
    );
  }

  /** Base64url credential ID, as the server stores it. */
  get id(): string {
    return b64url(this.credentialId);
  }

  /** Forces the next signature counter, to simulate a cloned authenticator. */
  setCounter(value: number): void {
    this.#counter = value;
  }

  /** Answers `navigator.credentials.create()` for the given options. */
  register(options: { challenge: string }): unknown {
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.#authDataHeader(FLAG_UP | FLAG_UV | FLAG_AT),
      Buffer.alloc(16), // AAGUID: zeros for "none" attestation
      idLength,
      this.credentialId,
      this.#cosePublicKey,
    ]);
    const attestationObject = cbor(
      new Map<CborValue, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** Answers `navigator.credentials.get()` for the given challenge. */
  authenticate(challenge: string, options: { origin?: string } = {}): unknown {
    this.#counter += 1;
    const clientDataJSON = this.#clientData('webauthn.get', challenge, options.origin);
    const authData = this.#authDataHeader(FLAG_UP | FLAG_UV);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }

  #clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  #authDataHeader(flags: number): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), counter]);
  }
}
