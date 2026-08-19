/** Spanish catalog for the extension-only approval-window hierarchy. */
import type { ApprovalUiMessageKey } from './approval-ui-en';

export const approvalUiEs: Record<ApprovalUiMessageKey, string> = {
  'approvalUi.requestedBy': 'Solicitado por',
  'approvalUi.transactionSummary': 'Resumen de la transacción',
  'approvalUi.leavingWallet': 'Sale de tu cartera',
  'approvalUi.enteringWallet': 'Entra en tu cartera',
  'approvalUi.walletContext': 'Usando',
  'approvalUi.fee.limitedLabel': 'Comisión verificada ahora',
  'approvalUi.fee.exactBody': 'Comisión exacta de esta transacción.',
  'approvalUi.fee.limitedBody':
    'Drey puede verificar esta cantidad ahora. La comisión final puede cambiar después de firmar.',
  'approvalUi.authorization.partial.title': 'Algunas salidas pueden cambiar',
  'approvalUi.authorization.partial.body':
    'Solo las salidas marcadas como Fija están bloqueadas. Las marcadas como Puede cambiar pueden sustituirse o eliminarse.',
  'approvalUi.output.committed': 'Fija',
  'approvalUi.output.changeable': 'Puede cambiar',
  'approvalUi.protectedFee.title': 'Firma bloqueada',
  'approvalUi.protectedFee.body':
    '{sats} sats protegidos pagarían la comisión. Vuelve a crear la transacción usando Bitcoin limpio para las comisiones.',
  'approvalUi.actions.closeEffect':
    'Rechaza solo esta solicitud o cierra la ventana para rechazar todas las solicitudes pendientes.',
  'approvalUi.warning.title': 'Comprueba antes de continuar',
  'approvalUi.warning.highFee':
    'La comisión de red es alta. Comprueba la cantidad antes de continuar.',
  'approvalUi.warning.highRelativeFee':
    'La comisión de red es alta en comparación con el pago. Comprueba la cantidad antes de continuar.',
  'approvalUi.warning.aboveTarget':
    'La comisión de red supera el objetivo elegido. Compruébala antes de continuar.',
  'approvalUi.advanced':
    'Solicitud avanzada. Firma solo si confías en el sitio y revisaste cada detalle de la transacción.',
  'approvalUi.flexible.title': 'El mercado puede actualizar esta transacción',
  'approvalUi.flexible.body':
    'El mercado puede añadir fondos o sustituir salidas marcadas como Puede cambiar. No puedes retirar la firma después de compartirla.',
  'approvalUi.marketplace.authenticate': '¿Iniciar sesión?',
  'approvalUi.marketplace.cancel': '¿Cancelar anuncio?',
  'approvalUi.marketplace.list': '¿Anunciar inscripción?',
  'approvalUi.marketplace.bulk_list': '¿Anunciar inscripciones?',
  'approvalUi.marketplace.buy': '¿Comprar inscripción?',
  'approvalUi.marketplace.secure_buy': '¿Comprar inscripción?',
  'approvalUi.marketplace.offer': '¿Hacer oferta?',
  'approvalUi.marketplace.accept_offer': '¿Aceptar oferta?',
  'approvalUi.marketplace.counter_offer': '¿Contraoferta?',
  'approvalUi.marketplace.accept_counter': '¿Aceptar contraoferta?',
  'approvalUi.marketplace.collection_offer': '¿Oferta de colección?',
  'approvalUi.marketplace.trait_offer': '¿Oferta por atributo?',
  'approvalUi.marketplace.transfer': '¿Transferir inscripción?',
  'approvalUi.marketplace.extract': '¿Extraer inscripción?',
  'approvalUi.marketplace.recover': '¿Recuperar inscripción?',
  'approvalUi.marketplace.unknown': '¿Revisar solicitud del mercado?',
};
