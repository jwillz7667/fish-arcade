# Cold treasury key ceremony

The procedure people follow to create the production 2-of-3 multisig that receives every deposit (spec §22.1, §22.4). This is the human gate in playbook Step 10.

**No AI tool, script in this repo, server, or CI job takes part.** The output of the ceremony is one watch-only descriptor. That descriptor is public key material only, and it is the only thing that ever reaches BTCPay.

> Never paste a seed, an xprv, or a private descriptor into any AI tool, chat, ticket, email, document, or repository. If a step seems to need one, stop. The procedure is wrong.

## Roles

| Role                 | Count | Does                                                                                              |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| Keyholder            | 3     | Owns one device and its metal backup. Generates the seed on that device. Never sees another seed  |
| Coordinator operator | 1     | Runs the wallet coordinator, such as Sparrow, on an offline machine. May be one of the keyholders |
| Witness              | 1     | Not a keyholder. Reads each check aloud and signs the ceremony log                                |

## Reef's layout: one keyholder

Reef's founder holds all three keys (ADR 0005). The roles above still apply, with the founder as every keyholder and as the coordinator operator. The witness should be someone who is not a keyholder, such as the company's attorney. The witness never sees a seed.

| Key | Device                | Device lives in | Metal backup lives in                        |
| --- | --------------------- | --------------- | -------------------------------------------- |
| 1   | Coldcard Q            | Home safe       | Bank safe deposit box                        |
| 2   | Trezor Safe 5         | Home safe       | Second bank's box, or the attorney's vault   |
| 3   | Blockstream Jade Plus | Relative's safe | Same bag as device 3, sealed, tamper-evident |

- A printed copy of the wallet descriptor goes with every backup. Two seeds cannot rebuild the wallet without the third xpub.
- No place holds two seeds, so no single place can spend. Losing any one place loses nothing.
- Devices 1 and 2 at home sign refills and weekly sweeps. Set a Coldcard trick PIN, and never discuss where the keys are.
- Leave a sealed continuity letter with the attorney: the places and this runbook, never seed words.
- This replaces the "different location from the other keyholders'" rule in ceremony step 9.

## Before the day

1. **Buy the devices.** Buy three hardware wallets from at least two vendors, directly from each manufacturer. Never buy from a marketplace or reseller. The vendors must support BIP 48 multisig and showing an address on screen. Write down each device's serial number and the condition of its tamper seal on arrival.
2. **Prepare backups.** Buy three metal seed backups and three tamper-evident bags.
3. **Prepare the coordinator.** Use a laptop that will stay offline for the ceremony. Install the coordinator (for example Sparrow) after checking the release signature against the developer's published key.
4. **Agree the policy.** The policy is 2-of-3, native SegWit P2WSH, keys sorted (`sortedmulti`), account path `m/48'/0'/0'/2'`. Decide in advance whether keyholders add BIP 39 passphrases. A passphrase protects a stolen backup, but losing it loses the key. If you use them, each passphrase gets its own backup and location.
5. **Rehearse on signet.** Run this whole procedure once on signet with spare devices, ending with the staging BTCPay. Most mistakes surface there.

## Ceremony

Do these steps in one session, in one room, with the witness present.

1. **Check each device.** Confirm the tamper seal and serial number against the arrival record. Update the firmware from the vendor's own tool, and verify it on the device.
2. **Generate each seed on its device, offline.** Each keyholder creates a new wallet on their own device. The device shows the seed; it never leaves the device by any other route.
3. **Back up each seed on metal.** The keyholder writes the seed onto metal, then lets the device verify the backup. Seal it in a tamper-evident bag and record the bag number. Nobody photographs, types, or speaks a seed.
4. **Export the public account key.** Each device exports its BIP 48 P2WSH account key for `m/48'/0'/0'/2'` (xpub, or Zpub on some devices) with its master fingerprint, by QR code or microSD. Never connect a device to an online machine.
5. **Build the multisig.** In the coordinator, create a 2-of-3 P2WSH wallet from the three exported keys. The coordinator produces a descriptor of this form:

   ```
   wsh(sortedmulti(2,[fp1/48h/0h/0h/2h]xpub1/<0;1>/*,[fp2/48h/0h/0h/2h]xpub2/<0;1>/*,[fp3/48h/0h/0h/2h]xpub3/<0;1>/*))#checksum
   ```

6. **Register the multisig on every device.** Import the wallet descriptor (or the vendor's multisig registration file) into each device, so each device can recognise its own change addresses and refuse a swapped key.
7. **Check the first receive address on every screen.** The coordinator shows receive address 0. The witness reads it aloud. Each device displays receive address 0 for the registered multisig, and every character must match. Record the address and the descriptor checksum in the log.
8. **Test a deposit and a spend.** Send a small amount to receive address 0 and wait for it to confirm. Spend it back by signing with two devices: first devices 1 and 2, then repeat with devices 2 and 3, so every device has signed. This proves every key works and every backup belongs to its device.
9. **Store everything apart.** Put each device and its metal backup in a different location from the other keyholders'. A single device and its own backup may share a location only if that location is under dual control. Record the locations and who can access each one.

## Connect the watch-only wallet to BTCPay

1. **Attach only the watch-only side.** In production BTCPay, attach the watch-only descriptor (or the xpub derivation scheme) to the store's on-chain wallet. This needs only public keys. The repo's regtest bootstrap (`packages/bitcoin/scripts/bootstrap-regtest.ts`) does this through the Greenfield API, which shows the shape.
2. **Check the address.** Confirm that BTCPay's first receive address matches the address recorded in step 7. If it differs, stop: BTCPay holds a different wallet.
3. **Confirm the settings.** The store uses 1-confirmation settlement (spec §22.2: never 0-conf) and 15-minute invoices.

## Hot wallet

The payout hot wallet is not part of this ceremony. Terraform creates its key in AWS KMS in Step 30, and the key never leaves KMS. No person ever sees it.

## Ceremony log

Keep the log in the company's access-controlled records, never in this repository. It records:

- the date, place, participants, and witness;
- device vendors, models, serial numbers, and firmware versions;
- the master fingerprint of each key (public, safe to record);
- the descriptor checksum and receive address 0;
- the test deposit and test spend transaction IDs;
- the backup bag numbers and storage locations;
- the signatures of the witness and every keyholder.

## Recovery and rotation

| Event                                  | Response                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One device lost or broken, backup safe | Restore the key onto a new device from its metal backup, register the multisig, and check address 0. No funds move                                                               |
| One key suspected compromised          | Funds are still safe, because one key cannot spend. Hold a new ceremony at once, sweep every coin to the new multisig with two clean keys, and update BTCPay's watch-only wallet |
| Two keys at risk                       | Treat as an emergency: sweep immediately with any two clean keys, then hold a new ceremony                                                                                       |
| A keyholder leaves                     | Rotate: new ceremony, sweep, update BTCPay. The departing keyholder's device and backup are destroyed under the witness's eye                                                    |

Rehearse a full restore from metal backups on signet at least once a year.
