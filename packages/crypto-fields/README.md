# @reef/crypto-fields

Envelope encryption for sensitive columns, plus HMAC blind indexes for looking up encrypted values.

|          |                                    |
| -------- | ---------------------------------- |
| Spec     | §15, §16; playbook Step 3          |
| Built in | Step 3 of `docs/BUILD_PLAYBOOK.md` |

## How it works

- `FieldCipher.encrypt(value, { table, column })` encrypts with AES-256-GCM under a data key. The data key comes from AWS KMS (`GenerateDataKey`, AES_256) in production, or from a local master key file in development.
- The result is a single string, `v1.<keyId>.<wrappedKey>.<iv>.<tag>.<ciphertext>` (base64url parts), stored in the `*_enc` column. Old rows stay readable after the key-encryption key rotates, because each envelope records its own key ID and wrapped data key.
- `table.column` is bound in as AAD, so a ciphertext copied into another column fails to decrypt.
- Data keys are reused for up to 10,000 encryptions or 15 minutes, to bound KMS calls. Unwrapped keys are cached (LRU, 1,000) for decryption.
- `BlindIndexer.index(value, kind)` is HMAC-SHA256 under a separate key, with per-kind normalisation: emails are lowercased, phones keep `+` and digits, bech32 addresses are lowercased.
- Every failure is typed. A tampered or misplaced value throws `IntegrityError`. A KMS outage throws `DependencyUnavailableError`, so callers fail closed.

## Config

| Variable                          | Production                             | Development                      |
| --------------------------------- | -------------------------------------- | -------------------------------- |
| `FIELD_ENCRYPTION_PROVIDER`       | `kms`                                  | `local` (rejected in production) |
| `FIELD_ENCRYPTION_KMS_KEY_ID`     | KMS key ARN or alias                   |                                  |
| `FIELD_ENCRYPTION_LOCAL_KEY_FILE` | rejected                               | `.keys/dev/field-master.key`     |
| `BLIND_INDEX_KEY`                 | base64, 32 bytes, from Secrets Manager |                                  |
| `BLIND_INDEX_KEY_FILE`            | rejected                               | `.keys/dev/blind-index.key`      |

`pnpm keys:dev` writes both dev key files (mode 0600). It never overwrites an existing file and refuses to run in production. Losing the blind index key makes every `*_bidx` lookup miss. Losing the master key makes every dev ciphertext unreadable.

## Test

```sh
pnpm vitest run --project crypto-fields
```
