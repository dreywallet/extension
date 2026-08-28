/** Extension-only copy for the browser approval window's review hierarchy. */
export const approvalUiEn = {
  'approvalUi.requestedBy': 'Requested by',
  'approvalUi.transactionSummary': 'Transaction summary',
  'approvalUi.batch.titleOne': 'Sign this transaction?',
  'approvalUi.batch.title': 'Sign {count} transactions?',
  'approvalUi.batch.summary': 'Batch summary',
  'approvalUi.batch.countOne': '1 transaction',
  'approvalUi.batch.count': '{count} independent transactions',
  'approvalUi.batch.feeExposure': 'Combined fee exposure',
  'approvalUi.batch.transaction': 'Transaction {number} of {count}',
  'approvalUi.batch.reviewEvery':
    'Review every transaction below. Drey returns all signatures in order, or none.',
  'approvalUi.group.linkedCount': '{count} related transactions',
  'approvalUi.group.maximumFees': 'Maximum network fees',
  'approvalUi.group.conservativeDebit': 'Conservative debit limit',
  'approvalUi.group.conservativeFees': 'Conservative fee limit',
  'approvalUi.group.conservativeBody':
    'These limits are conservative because some transaction options overlap.',
  'approvalUi.group.signedTogether':
    'Drey returns every signature together, or none. Nothing is broadcast.',
  'approvalUi.group.sharedFundingTitle': 'Shared funding',
  'approvalUi.group.sharedFundingBody':
    'Some transaction options use the same funds. Only one can be completed.',
  'approvalUi.group.possibleOutcomes': 'Possible outcomes',
  'approvalUi.group.outcomeSet': 'Sale or recovery',
  'approvalUi.group.outcomeSetNumbered': 'Sale or recovery {number}',
  'approvalUi.group.settlementOutcome': 'Marketplace settlement',
  'approvalUi.group.recoveryOutcome': 'Return to your wallet',
  'approvalUi.group.guaranteedReturn': 'At least {amount} returns to your wallet.',
  'approvalUi.group.outcomeMaximumDebit': 'Up to {amount} may leave your wallet.',
  'approvalUi.group.oneOutcome': 'Only one outcome in this set can complete.',
  'approvalUi.messageBatch.titleOne': 'Sign this message?',
  'approvalUi.messageBatch.title': 'Sign {count} messages?',
  'approvalUi.messageBatch.description':
    'Messages can sign you in or confirm an action. They cannot spend bitcoin.',
  'approvalUi.messageBatch.summaryOne': '1 message from this site',
  'approvalUi.messageBatch.summary': '{count} messages from this site',
  'approvalUi.messageBatch.message': 'Message {number} of {count}',
  'approvalUi.messageBatch.hiddenFormatting':
    'Hidden formatting is shown as U+ codes.',
  'approvalUi.messageBatch.signOne': 'Sign message',
  'approvalUi.messageBatch.sign': 'Sign messages',
  'approvalUi.leavingWallet': 'Leaving your wallet',
  'approvalUi.enteringWallet': 'Entering your wallet',
  'approvalUi.walletContext': 'Using',
  'approvalUi.fee.limitedLabel': 'Fee verified now',
  'approvalUi.fee.deferredLabel': 'Network fee now',
  'approvalUi.fee.exactBody': 'Exact fee for this transaction.',
  'approvalUi.fee.deferredBody': 'Added separately before broadcast.',
  'approvalUi.fee.limitedBody':
    'Drey can verify this amount now. The final fee may change after you sign.',
  'approvalUi.authorization.partial.title': 'Some outputs can change',
  'approvalUi.authorization.partial.body':
    'Only outputs marked Fixed are locked. Outputs marked Can change may be replaced or removed.',
  'approvalUi.output.committed': 'Fixed',
  'approvalUi.output.changeable': 'Can change',
  'approvalUi.signatureRules.title': 'Signature rules',
  'approvalUi.signatureRules.input': 'Input {number}',
  'approvalUi.signatureRules.inputCount': '{count} inputs use this rule',
  'approvalUi.signatureRules.inputsFixed': 'All current inputs are fixed.',
  'approvalUi.signatureRules.inputsChangeable':
    'The site can add or remove other inputs.',
  'approvalUi.signatureRules.outputsFixed': 'All current outputs are fixed.',
  'approvalUi.signatureRules.outputCorresponding': 'Only output {number} is fixed.',
  'approvalUi.signatureRules.outputsCorrespondingEach':
    'Each signature fixes its matching output.',
  'approvalUi.signatureRules.feeFixed': 'The network fee is fixed.',
  'approvalUi.signatureRules.feeDeferred':
    'This transaction stays at 0 sats; the package fee is added elsewhere.',
  'approvalUi.signatureRules.feeChangeable': 'The final network fee can change.',
  'approvalUi.signatureRules.deferredFeeTitle': 'Fee added later',
  'approvalUi.signatureRules.deferredFeeBody':
    'The current outputs are fixed. A linked transaction or the site must add the package fee before broadcast.',
  'approvalUi.signatureRules.someDeferredFeeTitle': 'Some fees are added later',
  'approvalUi.signatureRules.someDeferredFeeBody':
    'Transactions marked below stay at 0 sats. Other transactions keep their displayed fee.',
  'approvalUi.protectedFee.title': 'Signing blocked',
  'approvalUi.protectedFee.body':
    '{sats} protected sats would pay the fee. Rebuild this transaction using clean Bitcoin for fees.',
  'approvalUi.actions.closeEffect':
    'Reject affects this request. Closing the window cancels all pending requests.',
  'approvalUi.warning.title': 'Check before continuing',
  'approvalUi.warning.highFee':
    'The network fee is high. Check the amount before continuing.',
  'approvalUi.warning.highRelativeFee':
    'The network fee is high compared with the payment. Check the amount before continuing.',
  'approvalUi.warning.aboveTarget':
    'The network fee is above your selected target. Check it before continuing.',
  'approvalUi.advanced':
    'Advanced request. Sign only if you trust the site and have checked every transaction detail.',
  'approvalUi.flexible.title': 'Marketplace can update this transaction',
  'approvalUi.flexible.body':
    'The marketplace may add funding or replace outputs marked Can change. You cannot take back the signature after sharing it.',
  'approvalUi.genericListing.title': 'List inscription?',
  'approvalUi.genericListing.sign': 'Sign listing',
  'approvalUi.genericListing.flexibleBody':
    'The site may add funding or replace outputs marked Can change. You cannot take back the signature after sharing it.',
  'approvalUi.marketplace.authenticate': 'Sign in?',
  'approvalUi.marketplace.cancel': 'Cancel listing?',
  'approvalUi.marketplace.list': 'List inscription?',
  'approvalUi.marketplace.bulk_list': 'List inscriptions?',
  'approvalUi.marketplace.buy': 'Buy inscription?',
  'approvalUi.marketplace.secure_buy': 'Buy inscription?',
  'approvalUi.marketplace.offer': 'Make offer?',
  'approvalUi.marketplace.accept_offer': 'Accept offer?',
  'approvalUi.marketplace.counter_offer': 'Counter offer?',
  'approvalUi.marketplace.accept_counter': 'Accept counter?',
  'approvalUi.marketplace.collection_offer': 'Collection offer?',
  'approvalUi.marketplace.trait_offer': 'Trait offer?',
  'approvalUi.marketplace.transfer': 'Transfer inscription?',
  'approvalUi.marketplace.extract': 'Extract inscription?',
  'approvalUi.marketplace.recover': 'Recover inscription?',
  'approvalUi.marketplace.unknown': 'Review marketplace request?',
} as const;

export type ApprovalUiMessageKey = keyof typeof approvalUiEn;
