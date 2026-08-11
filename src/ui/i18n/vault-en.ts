/**
 * Extension-only English strings for the Vault coordinator (ADR 0007 §8).
 *
 * Unlike passkey-en.ts, this catalog is NOT the home for the feature's whole
 * vocabulary. ADR 0007 §2 gives mobile the role-B signer, so the role, policy,
 * and safety strings — what a fingerprint is, that these words are not the
 * Spending Recovery Phrase, that deleting a role is not revocation — live in
 * the portable en.ts/es.ts catalogs that mobile mirrors byte-for-byte. Copy
 * that must read identically wherever a Vault role is held should not have two
 * independent wordings.
 *
 * What stays here is copy tied to the extension coordinator, its build channel,
 * and Desktop A recovery. Those statements are not portable role vocabulary.
 */
export const vaultEn = {
  'vault.import.challengeQrCreate': 'Create Mobile B challenge QR',
  'vault.import.challengeQrAlt': 'Mobile B challenge QR, frame {index} of {count}',
  'vault.import.challengeQrPart': 'Challenge frame {index} of {count}',
  'vault.import.challengeQrPrevious': 'Previous frame',
  'vault.import.challengeQrNext': 'Next frame',
  'vault.error.unavailable': 'The Vault coordinator is not available in this build.',

  'settings.vault.entry': 'Drey Vault',

  'vault.title': 'Drey Vault',
  'vault.banner':
    '2-of-3 multisignature custody. Two independent roles are required for every transaction; Recovery C stays offline for emergencies.',
  'vault.scope':
    'Create Desktop A, pair independent Mobile B, establish offline Recovery C, verify every backup, then deposit, scan, review, sign, and broadcast with authenticated QR transport.',

  'vault.role.defaultLabel': 'Desktop A',
  'vault.policy.defaultLabel': 'Drey Vault',
  'vault.policy.qrHeading': 'Finish pairing on Mobile B',
  'vault.policy.qrBody':
    'Scan this authenticated policy QR on the same phone before leaving this page. It commits the exact signers and descriptors to Mobile B.',
  'vault.policy.qrAlt': 'Vault policy QR part {index} of {count}',
  'vault.policy.qrPart': 'Policy QR part {index} of {count}',

  'vault.next':
    'Keep the recovery kit and Recovery C phrase offline and separate from Desktop A and Mobile B.',
  'vault.roleARecovery.title': 'Passkey-encrypted Desktop A recovery',
  'vault.roleARecovery.body':
    'Export Role A as an encrypted file for the offline recovery page. The file still needs this exact passkey and recovers only one of the two signatures required to spend.',
  'vault.roleARecovery.passkeyRequired':
    'Enroll a passkey for this wallet before exporting the encrypted Role A recovery file.',
  'vault.roleARecovery.passkey': 'Recovery passkey',
  'vault.roleARecovery.export': 'Verify and export Role A recovery file',
  'vault.roleARecovery.exported':
    'Encrypted Role A recovery file downloaded. Store it separately from Recovery C and the public kit.',
  'vault.roleARecovery.failed': 'The passkey ceremony or Role A package verification failed.',
  'vault.roleARecovery.openOffline': 'Open offline Role A recovery page',

  // The retained unsigned-only mainnet profile. This build watches
  // a real chain and can build unsigned plans, so the signed-evidence path is
  // proven against real data — but nothing here can sign, so anything sent to
  // this Vault stays stuck until the signing package ships. Say that outright.
  'vault.mainnet.banner':
    'MAINNET PILOT — CANNOT SIGN. This build watches a real Vault and can prepare unsigned transactions, but it cannot sign or send them. DO NOT FUND IT YET: coins sent here cannot be moved until Vault signing ships, and recovering them would need two of the three roles plus this policy.',
  'vault.production.banner':
    'MAINNET VAULT. This build can coordinate, independently review, sign and broadcast real 2-of-3 Vault transactions. Verify the destination, amount, fee, asset effects and signer roles before approval.',
  'vault.mainnet.doNotFund':
    'Do not send bitcoin to this address yet — nothing here can spend it.',

  // The former pilot and current production mainnet profiles can sign and
  // broadcast. Permanent transaction-integrity rules, not a coded rollout
  // ceiling, bound their behavior.
  'vault.pilot.banner':
    'MAINNET VAULT — REAL BITCOIN. Confirm the exact destination, amount, fee, asset effects, and two independent signer roles before approval.',
  'vault.pilot.bound':
    'Every movement is rebuilt from fresh signed evidence and checked for exact fee, inputs, outputs, change ownership, inscriptions, and signature policy.',
  // The plan lifecycle (Workstreams C4-C6). Extension-only rather than shared:
  // The coordinator remains a build-channel surface rather than shared wallet
  // RPC. Role, policy, and safety vocabulary stays portable.
  'vault.error.planMissing': 'There is no Vault transaction to work on.',
  'vault.error.planRejected': 'This transaction failed Vault ownership, evidence, fee, or asset-safety policy.',
  'vault.error.planStale':
    'This transaction is out of date — the coin information behind it has expired. Build it again.',
  'vault.error.planAlreadyBroadcast': 'This transaction has already been sent.',
  'vault.error.broadcastIndeterminate':
    'A previous send of this transaction ended without a known result. Check whether it reached the network before trying again.',

  'vault.plan.heading': 'Withdraw to your Spending wallet',
  'vault.plan.body':
    'Move proven-clean bitcoin or one confirmed inscription UTXO to your paired Spending wallet. Protected value is never used for fees.',
  'vault.plan.amount': 'Amount (sats)',
  'vault.plan.cardinal': 'Bitcoin',
  'vault.plan.inscription': 'Inscription',
  'vault.plan.inscriptionId': 'Exact inscription ID',
  'vault.plan.digest': 'Plan digest',
  'vault.plan.feeRate': 'Fee rate (sats per kvB)',
  'vault.plan.build': 'Build transaction',
  'vault.plan.transactionType': 'Transaction type',
  'vault.plan.cpfpType': 'Fee acceleration (CPFP)',
  'vault.plan.cpfpHeading': 'Transaction still pending?',
  'vault.plan.cpfpBody':
    'Create a child transaction that spends only this withdrawal’s verified Vault change. Its fee raises the effective rate of the parent and child together.',
  'vault.plan.cpfpOpen': 'Speed up transaction',
  'vault.plan.cpfpFeeRate': 'Target package fee rate (sats per kvB)',
  'vault.plan.cpfpBuild': 'Review speed-up transaction',
  'vault.plan.cpfpBuilt': 'Speed-up transaction built. Review and approve it like any Vault withdrawal.',
  'vault.plan.destination': 'Destination',
  'vault.plan.change': 'Vault change',
  'vault.plan.vsize': 'Maximum virtual size',
  'vault.plan.outputs': 'All outputs',
  'vault.plan.assets': 'Protected asset effects',
  'vault.plan.fee': 'Fee',
  'vault.plan.size': 'Size (vbytes)',
  'vault.plan.inputs': 'Coins used',
  'vault.plan.expires': 'Usable until',
  'vault.plan.stale': 'This transaction is out of date. Build it again before signing.',
  'vault.plan.discard': 'Discard',
  'vault.plan.sign': 'Sign as this device',
  'vault.plan.signed': 'Signed. Send the text below to the second signer.',
  'vault.plan.psbt': 'Transaction to sign (hex)',
  'vault.plan.peerPsbt': "Second signer's returned text (hex)",
  'vault.plan.mobileQrHeading': 'Request independent Mobile B approval',
  'vault.plan.mobileQrBody':
    'Scan both the authenticated request and PSBT on Mobile B. Review and sign there, then scan both returned items below.',
  'vault.plan.mobileContextQr': 'Authenticated Mobile B approval request QR',
  'vault.plan.mobilePsbtQr': 'Vault PSBT QR',
  'vault.plan.qrPart': 'QR part {index} of {count}',
  'vault.plan.scanMobileContext': 'Scan Mobile B result',
  'vault.plan.scanMobilePsbt': 'Scan signed PSBT',
  'vault.plan.mobileRequestHeading': 'Approve a Mobile-coordinated transaction',
  'vault.plan.mobileRequestBody':
    'Scan the authenticated request and PSBT from Mobile B. Desktop A independently rescans the Vault and reconstructs every reviewed field before signing.',
  'vault.plan.scanMobileRequest': 'Scan Mobile B request',
  'vault.plan.scanMobileRequestPsbt': 'Scan Mobile B PSBT',
  'vault.plan.signMobileRequest': 'Review complete — sign as Desktop A',
  'vault.plan.mobileRequestSigned': 'Desktop A signed the independently verified mobile request.',
  'vault.plan.mobileResultContextQr': 'Desktop A approval result QR',
  'vault.plan.mobileResultPsbtQr': 'Desktop A signed PSBT QR',
  'vault.plan.combine': 'Combine signatures',
  'vault.plan.finalize': 'Finish transaction',
  'vault.plan.finalized': 'Finished. Review it, then send it.',
  'vault.plan.transaction': 'Finished transaction (hex)',
  'vault.plan.broadcast': 'Send',
  'vault.plan.broadcastState': 'Send result',
  'vault.plan.preparedResume': 'These exact transaction bytes are durably prepared and may be sent once.',
  'vault.plan.reconcileOnly': 'This transaction may already have been sent. Do not retry or discard it; reconcile the exact transaction ID on chain.',
  'vault.plan.reconcile': 'Check exact transaction on chain',
  'vault.plan.reconciled': 'The exact transaction check finished.',
  'vault.plan.txid': 'Transaction ID',
  'vault.plan.deposit': 'Vault deposit address',
  'vault.plan.depositShow': 'Show deposit address',
  'vault.plan.depositBody':
    'Send from your Spending wallet to this address. It is regenerated from the policy every time it is shown, never remembered.',

  // The everyday coordinator exchanges public, bounded files only. Recovery C
  // words are created and re-entered by the separately downloaded offline tool.
  'vault.error.recoveryCSessionMissing':
    'That Recovery C challenge is no longer open. Download a new challenge and answer that exact file offline.',
  'vault.error.recoveryCResponseRejected':
    'That Recovery C response was refused. It may be damaged, expired, for another Vault or network, or an answer to an older challenge.',
  'vault.error.recoveryCKitRequired':
    'Save the public recovery kit before starting the paper-backup check.',
  'vault.error.recoveryCBackupRequired':
    'Funding and transfers stay blocked until the offline paper-backup check passes.',
  'vault.recoveryC.heading': 'Offline Recovery C readiness',
  'vault.recoveryC.summary':
    'Recovery C is one vote in this 2-of-3 Vault. It cannot spend alone and it is not a backup of your Spending wallet. Drey never creates, receives, or stores its 12 words.',
  'vault.recoveryC.setupHeading': 'Create Recovery C offline',
  'vault.recoveryC.setupBody':
    'Download a public challenge, move it to a trusted computer that is disconnected from every network, and run the verified standalone recovery tool there. Only its public response file comes back to this computer.',
  'vault.recoveryC.prepareOffline': 'Prepare a trusted computer and disconnect Wi-Fi, Ethernet, and Bluetooth.',
  'vault.recoveryC.preparePaper': 'Prepare durable paper and a pen for the 12 Recovery C words.',
  'vault.recoveryC.prepareSeparate': 'Plan to store those words separately from the public recovery kit.',
  'vault.recoveryC.preparePowerOff': 'After the response is saved, power the offline computer off before reconnecting anything.',
  'vault.recoveryC.setupStart': 'Download setup challenge',
  'vault.recoveryC.setupReplace': 'Replace setup challenge',
  'vault.recoveryC.setupDownloaded':
    'Setup challenge downloaded. Complete it with the standalone tool on the offline computer, then choose its response file here.',
  'vault.recoveryC.setupCancelled': 'The setup challenge was cancelled. Any response to it will be refused.',
  'vault.recoveryC.setupInterrupted':
    'A previous challenge is still open, but this page does not retain its download. Replace it before continuing; the older response will be refused.',
  'vault.recoveryC.setupWaiting':
    'Waiting for the public offline response. Challenge fingerprint: {fingerprint}.',
  'vault.recoveryC.responseFile': 'Choose the public response file',
  'vault.recoveryC.noFile': 'No file was selected. The current challenge is still open.',
  'vault.recoveryC.fileSize': 'That file is empty or larger than the 64 KiB public-record limit.',
  'vault.recoveryC.fileReadFailed': 'The selected file could not be read. The current challenge is still open.',
  'vault.recoveryC.downloadFailed': 'The public challenge file could not be downloaded. Try again before going offline.',
  'vault.recoveryC.setupComplete': 'Recovery C was verified. Its words remain only on your paper copy.',
  'vault.recoveryC.stepSetup': '1. Create and prove Recovery C on the offline computer.',
  'vault.recoveryC.stepSetupDone': '1. Recovery C public signer verified.',
  'vault.recoveryC.stepKit': '2. Save the public recovery kit separately from the words.',
  'vault.recoveryC.stepKitDone': '2. Public recovery kit saved.',
  'vault.recoveryC.stepBackup': '3. Re-enter the paper words offline and return the signed check.',
  'vault.recoveryC.stepBackupDone': '3. Paper-backup check passed.',
  'vault.recoveryC.kitRequired':
    'Show the recovery kit below and download its file. This public file reveals every Vault address, so protect its privacy and keep it away from the Recovery C words.',
  'vault.recoveryC.kitDownloadStarted':
    'The download started. Confirm only after you can see the kit file in a separate storage location.',
  'vault.recoveryC.kitConfirm': 'I saved the kit separately',
  'vault.recoveryC.kitComplete': 'Recovery kit location confirmed. The offline paper check can now begin.',
  'vault.recoveryC.backupStart': 'Download paper-check challenge',
  'vault.recoveryC.backupReplace': 'Replace paper-check challenge',
  'vault.recoveryC.backupDownloaded':
    'Paper-check challenge downloaded. On the offline computer, re-enter all 12 words from paper and return only the public response file.',
  'vault.recoveryC.backupWaiting':
    'Waiting for the public paper-check response. Challenge fingerprint: {fingerprint}.',
  'vault.recoveryC.fundingBlocked':
    'Do not fund this Vault yet. Deposit addresses and every value-moving action remain blocked until all three steps pass.',
  'vault.recoveryC.ready':
    'Recovery C is ready. The paper copy was proved against this exact Vault policy.',
  'vault.recoveryC.unusable':
    'The saved Recovery C checks cannot be verified. Do not fund or transfer. If this Vault is certainly empty, remove its policy and restart setup. If it may hold funds, keep the policy and use two verified roles with the standalone recovery tool.',

  // §6 kit transport (download/QR/print). Extension-only: how this build
  // moves the kit onto paper or removable media is coordinator-channel
  // mechanics, not Vault vocabulary.
  'vault.kit.download': 'Download kit file',
  'vault.kit.print': 'Print kit',
  'vault.kit.qr.show': 'Show kit as QR codes',
  'vault.kit.qr.hide': 'Hide QR codes',
  'vault.kit.qr.body':
    'Scan every part, in any order. Each scan starts with its part number; the parts together are the whole kit, and the standalone recovery tool accepts them joined in order with the labels removed. Store the kit safely — it cannot spend, but it reveals every Vault address.',
  'vault.kit.qr.part': 'Part {index} of {count}',
  'vault.kit.qr.alt': 'Recovery kit QR code, part {index} of {count}',

  // Production authenticated Vault context and standards-valid PSBT optical transport.
  'vault.transportScanner.open': 'Open Vault QR scanner',
  'vault.transportScanner.scanOrigin': 'Scan Mobile B identity QR',
  'vault.transportScanner.title': 'Vault QR scanner',
  'vault.transportScanner.body':
    'Partial scans are discarded on background or cancellation. Drey imports only a complete verified Vault context or standards-valid PSBT.',
  'vault.transportScanner.video': 'Camera preview for Vault QR codes',
  'vault.transportScanner.start': 'Start camera',
  'vault.transportScanner.resume': 'Restart camera',
  'vault.transportScanner.cancel': 'Stop camera',
  'vault.transportScanner.scanning': 'Camera active. Local decoder: {decoder}.',
  'vault.transportScanner.progress': 'Received {received} of {expected} Vault QR frames.',
  'vault.transportScanner.duplicate': 'That frame was already received. Keep scanning.',
  'vault.transportScanner.complete': 'Vault QR reconstructed and verified.',
  'vault.transportScanner.background': 'Camera stopped when this page left the foreground.',
  'vault.transportScanner.denied': 'Camera access was denied. Nothing was captured.',
  'vault.transportScanner.unavailable': 'No usable camera is available.',
  'vault.transportScanner.error.ambiguous': 'More than one QR code was visible. Show only one code.',
  'vault.transportScanner.error.mixed': 'That frame belongs to a different transport session.',
  'vault.transportScanner.error.tampered': 'That frame was damaged or changed and was refused.',
  'vault.transportScanner.error.type': 'That QR code is not the Vault type expected for this step.',
  'vault.transportScanner.error.unsupported': 'That fountain frame form is not supported yet.',
  'vault.transportScanner.error.invalid': 'That QR code is not a canonical bounded UR frame.',
  'vault.transportScanner.error.generic': 'The camera frame could not be processed safely.',

  'vault.tool.heading': 'Standalone recovery tool',
  'vault.tool.body':
    'This kit names an offline program that can open this Vault with any two roles, without Drey. Check what you downloaded against these before you trust it — if either disagrees, stop.',
  'vault.tool.source': 'Built from',
  'vault.tool.artifact': 'Program checksum (SHA-256)',
  'vault.tool.reproduce':
    'Rebuild it yourself: clone that tag, then run pnpm install --frozen-lockfile && pnpm recovery:verify. It builds twice and fails unless the bytes match.',

  'vault.pilot.noIndependence':
    'Custody requires real independence. Keep Desktop A and Mobile B on separate devices and create Recovery C only with the verified offline ceremony.',
} as const;

export type VaultMessageKey = keyof typeof vaultEn;
