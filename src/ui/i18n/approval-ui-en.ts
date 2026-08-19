/** Extension-only copy for the browser approval window's review hierarchy. */
export const approvalUiEn = {
  'approvalUi.requestedBy': 'Requested by',
  'approvalUi.transactionSummary': 'Transaction summary',
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
    'Reject this request only, or close the window to reject all pending requests.',
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
