import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { KmsDataKeyProvider, type KmsSender } from './kms-provider.js';

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function sender(handler: (command: unknown) => unknown): KmsSender & { commands: unknown[] } {
  const commands: unknown[] = [];
  return {
    commands,
    send: ((command: unknown) => {
      commands.push(command);
      return Promise.resolve().then(() => handler(command));
    }) as KmsSender['send'],
  };
}

const ARN = 'arn:aws:kms:us-east-1:000000000000:key/test';
const unavailable = expect.objectContaining({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });
const integrity = expect.objectContaining({ code: ErrorCode.INTEGRITY_VIOLATION });

describe('KmsDataKeyProvider', () => {
  it('requests an AES_256 data key for the configured key', async () => {
    const client = sender(() => ({
      KeyId: ARN,
      Plaintext: new Uint8Array(32).fill(7),
      CiphertextBlob: new Uint8Array([1, 2, 3]),
    }));

    const key = await new KmsDataKeyProvider(client, 'alias/reef-fields').generateDataKey();

    expect(client.commands[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect((client.commands[0] as GenerateDataKeyCommand).input).toEqual({
      KeyId: 'alias/reef-fields',
      KeySpec: 'AES_256',
    });
    expect([key.keyId, key.plaintext.length, [...key.wrapped]]).toEqual([ARN, 32, [1, 2, 3]]);
  });

  it('fails closed when KMS errors or returns an incomplete key', async () => {
    const failing = new KmsDataKeyProvider(
      sender(() => Promise.reject(named('ThrottlingException'))),
      ARN,
    );
    const incomplete = new KmsDataKeyProvider(
      sender(() => ({ KeyId: ARN })),
      ARN,
    );

    await expect(failing.generateDataKey()).rejects.toThrow(unavailable);
    await expect(incomplete.generateDataKey()).rejects.toThrow(unavailable);
  });

  it('decrypts with the recorded key ID', async () => {
    const client = sender(() => ({ Plaintext: new Uint8Array(32).fill(9) }));

    const plaintext = await new KmsDataKeyProvider(client, 'alias/other').decryptDataKey(
      ARN,
      Buffer.from([5]),
    );

    expect(client.commands[0]).toBeInstanceOf(DecryptCommand);
    expect((client.commands[0] as DecryptCommand).input.KeyId).toBe(ARN);
    expect(plaintext.length).toBe(32);
  });

  it.each(['InvalidCiphertextException', 'IncorrectKeyException'])(
    'maps %s to an integrity error',
    async (name) => {
      const provider = new KmsDataKeyProvider(
        sender(() => Promise.reject(named(name))),
        ARN,
      );

      await expect(provider.decryptDataKey(ARN, Buffer.from([1]))).rejects.toThrow(integrity);
    },
  );

  it('maps other decrypt failures and empty responses to unavailable', async () => {
    const down = new KmsDataKeyProvider(
      sender(() => Promise.reject(named('KMSInternalException'))),
      ARN,
    );
    const empty = new KmsDataKeyProvider(
      sender(() => ({})),
      ARN,
    );

    await expect(down.decryptDataKey(ARN, Buffer.from([1]))).rejects.toThrow(unavailable);
    await expect(empty.decryptDataKey(ARN, Buffer.from([1]))).rejects.toThrow(unavailable);
  });
});
