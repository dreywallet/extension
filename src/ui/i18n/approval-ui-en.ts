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
  'approvalUi.fee.exactBody': 'Exact fee for this transaction.',
  'approvalUi.fee.limitedBody':
    'Drey can verify this amount now. The final fee may change after you sign.',
  'approvalUi.authorization.partial.title': 'Some outputs can change',
  'approvalUi.authorization.partial.body':
    'Only outputs marked Fixed are locked. Outputs marked Can change may be replaced or removed.',
  'approvalUi.output.committed': 'Fixed',
  'approvalUi.output.changeable': 'Can change',
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
