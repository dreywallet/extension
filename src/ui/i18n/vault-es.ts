/** Spanish catalog for the extension-only Vault coordinator strings (see vault-en.ts). */
import type { VaultMessageKey } from './vault-en';

export const vaultEs: Record<VaultMessageKey, string> = {
  'vault.import.challengeQrCreate': 'Crear QR de emparejamiento',
  'vault.import.challengeQrAlt': 'QR de desafío para Móvil B, fotograma {index} de {count}',
  'vault.import.challengeQrPart': 'Fotograma de desafío {index} de {count}',
  'vault.import.challengeQrPrevious': 'Fotograma anterior',
  'vault.import.challengeQrNext': 'Fotograma siguiente',
  'vault.error.unavailable': 'El coordinador de la Bóveda no está disponible en esta versión.',

  'settings.vault.entry': 'Drey Vault',

  'vault.title': 'Drey Vault',
  'vault.banner':
    'Custodia multifirma 2 de 3. Cada transacción requiere dos roles independientes; Recuperación C permanece sin conexión para emergencias.',
  'vault.scope':
    'Crea Escritorio A, empareja Mobile B independiente, configura Recuperación C sin conexión, verifica las copias y usa transporte QR autenticado para revisar y firmar.',
  'vault.create.after':
    'A continuación, conectarás tu teléfono y configurarás un rol de recuperación sin conexión. No depositarás bitcoin hasta verificar los tres roles y sus copias de seguridad.',
  'vault.setup.desktopReady': 'Paso 1 completado',
  'vault.setup.connectTitle': 'Siguiente: conecta tus otros dos roles',
  'vault.setup.connectBody':
    'Ten preparados tu teléfono y el dispositivo de recuperación sin conexión. Drey te guiará primero por Mobile B y después por Recuperación C.',
  'vault.setup.mobileReady': 'Paso 2 completado',
  'vault.setup.recoveryTitle': 'Siguiente: crea Recuperación C sin conexión',
  'vault.setup.recoveryBody':
    'Prepara un ordenador sin conexión, papel y una unidad extraíble. Drey te guiará para crear y comprobar el rol de recuperación sin exponer sus palabras en línea.',
  'vault.setup.rolesReady': 'Los tres roles están listos',
  'vault.setup.createTitle': 'Siguiente: crea la Bóveda',
  'vault.setup.createBody':
    'Vincula los tres roles en una Bóveda 2 de 3. Aún no depositarás bitcoin hasta completar las comprobaciones de recuperación.',
  'vault.import.mobileStep': 'Paso 2 de 4',
  'vault.import.mobileTitle': 'Conectar Mobile B',
  'vault.import.mobileIntro':
    'En el teléfono que usarás como Mobile B, abre Drey Vault y muestra su QR de identidad de Mobile B.',
  'vault.import.scanIdentityHelp': 'Primero, escanea el QR de identidad que aparece en tu teléfono.',
  'vault.import.identityScanned': 'Identidad de Mobile B escaneada.',
  'vault.import.passwordHint':
    'Esto confirma Escritorio A antes de que Drey cree un QR que solo este teléfono puede responder.',
  'vault.import.scanChallengeHelp':
    'Escanea este QR de emparejamiento con Mobile B. El teléfono mostrará dos respuestas; vuelve aquí y escanea primero la Respuesta 1 y luego la Respuesta 2.',
  'vault.import.responseOneScanned': 'Respuesta 1 de 2 escaneada. Ahora escanea la Respuesta 2.',
  'vault.import.responseScanned': 'Ambas respuestas escaneadas. Termina de conectar Mobile B abajo.',
  'vault.import.technical': 'Detalles técnicos y entrada manual',
  'vault.import.recoveryStep': 'Paso 3 de 4',
  'vault.import.continue': 'Continuar configuración',
  'vault.import.backToOverview': 'Volver al resumen de configuración',

  'vault.role.defaultLabel': 'Escritorio A',
  'vault.policy.defaultLabel': 'Drey Vault',
  'vault.policy.placeholder': 'p. ej., Bóveda familiar',
  'vault.policy.hint':
    'Elige cualquier nombre que te ayude a reconocer esta Bóveda. Déjalo en blanco para usar «Drey Vault».',
  'vault.policy.qrHeading': 'Termina el emparejamiento en Mobile B',
  'vault.policy.qrBody':
    'Escanea este QR de política autenticado en el mismo teléfono antes de salir. Confirma los firmantes y descriptores exactos en Mobile B.',
  'vault.policy.qrAlt': 'Parte {index} de {count} del QR de política de Vault',
  'vault.policy.qrPart': 'Parte {index} de {count} del QR de política',
  'vault.policy.mobileStep': 'Paso 4 de 4',
  'vault.policy.qrCompleteAction': 'Mobile B muestra «Vault lista»',
  'vault.policy.qrComplete': 'Emparejamiento de Mobile B completado. La configuración de tu Vault está guardada.',
  'vault.policy.qrMissing':
    'El QR final caducó o se cerró. Introduce la contraseña de la aplicación para crear uno nuevo; tu Vault y los pasos completados están a salvo.',
  'vault.policy.qrRefresh': 'Crear un nuevo QR final',

  'vault.next':
    'Guarda el kit de recuperación y la frase de Recuperación C sin conexión y separados de Escritorio A y Mobile B.',
  'vault.roleARecovery.title': 'Recuperación cifrada con passkey de Escritorio A',
  'vault.roleARecovery.body':
    'Exporta el rol A como archivo cifrado para la página de recuperación sin conexión. El archivo aún necesita esta passkey y recupera solo una de las dos firmas necesarias para gastar.',
  'vault.roleARecovery.passkeyRequired':
    'Registra una passkey para esta cartera antes de exportar el archivo cifrado de recuperación del rol A.',
  'vault.roleARecovery.passkey': 'Passkey de recuperación',
  'vault.roleARecovery.export': 'Verificar y exportar archivo de recuperación del rol A',
  'vault.roleARecovery.exported':
    'Archivo cifrado de recuperación del rol A descargado. Guárdalo separado de Recuperación C y del kit público.',
  'vault.roleARecovery.failed': 'Falló la ceremonia de passkey o la verificación del paquete del rol A.',
  'vault.roleARecovery.openOffline': 'Abrir página de recuperación sin conexión del rol A',

  'vault.mainnet.banner':
    'PILOTO EN MAINNET — NO PUEDE FIRMAR. Esta versión observa una Bóveda real y puede preparar transacciones sin firmar, pero no puede firmarlas ni enviarlas. NO LA FINANCIES TODAVÍA: las monedas enviadas aquí no se podrán mover hasta que exista la firma de la Bóveda, y recuperarlas requeriría dos de los tres roles más esta política.',
  'vault.production.banner':
    'VAULT DE MAINNET. Esta versión puede coordinar, revisar de forma independiente, firmar y difundir transacciones Vault reales de 2 de 3. Verifica el destino, el monto, la comisión, los efectos de activos y los roles antes de aprobar.',
  'vault.mainnet.doNotFund':
    'Todavía no envíes bitcoin a esta dirección: nada aquí puede gastarla.',

  'vault.pilot.banner':
    'VAULT EN MAINNET — BITCOIN REAL. Confirma el destino, monto, comisión, efectos de activos y dos roles independientes antes de aprobar.',
  'vault.pilot.bound':
    'Cada movimiento se reconstruye con evidencia firmada reciente y verifica comisión, entradas, salidas, cambio, inscripciones y política de firmas.',
  'vault.error.planMissing': 'No hay ninguna transacción de la Bóveda en curso.',
  'vault.error.planRejected':
    'Esta transacción no cumple la política de propiedad, evidencia, comisión o seguridad de activos de Vault.',
  'vault.error.planStale':
    'Esta transacción está desactualizada: la información de monedas en la que se basa ha caducado. Créala de nuevo.',
  'vault.error.planAlreadyBroadcast': 'Esta transacción ya se envió.',
  'vault.error.broadcastIndeterminate':
    'Un envío anterior de esta transacción terminó sin un resultado conocido. Comprueba si llegó a la red antes de volver a intentarlo.',

  'vault.plan.heading': 'Retirar a tu billetera de Gasto',
  'vault.plan.body':
    'Mueve bitcoin limpio verificado o una UTXO de inscripción confirmada a tu billetera de Gasto emparejada. El valor protegido nunca paga comisiones.',
  'vault.plan.amount': 'Cantidad (sats)',
  'vault.plan.cardinal': 'Bitcoin',
  'vault.plan.inscription': 'Inscripción',
  'vault.plan.inscriptionId': 'ID exacto de inscripción',
  'vault.plan.digest': 'Resumen criptográfico del plan',
  'vault.plan.feeRate': 'Tarifa (sats por kvB)',
  'vault.plan.build': 'Crear transacción',
  'vault.plan.transactionType': 'Tipo de transacción',
  'vault.plan.cpfpType': 'Aceleración de tarifa (CPFP)',
  'vault.plan.cpfpHeading': '¿La transacción sigue pendiente?',
  'vault.plan.cpfpBody':
    'Crea una transacción hija que gasta únicamente el cambio verificado de esta retirada de la Bóveda. Su tarifa aumenta la tasa efectiva de la transacción original y la hija juntas.',
  'vault.plan.cpfpOpen': 'Acelerar transacción',
  'vault.plan.cpfpFeeRate': 'Tarifa objetivo del paquete (sats por kvB)',
  'vault.plan.cpfpBuild': 'Revisar transacción de aceleración',
  'vault.plan.cpfpBuilt': 'Se creó la transacción de aceleración. Revísala y apruébala como cualquier retirada de la Bóveda.',
  'vault.plan.destination': 'Destino',
  'vault.plan.change': 'Cambio de la bóveda',
  'vault.plan.vsize': 'Tamaño virtual máximo',
  'vault.plan.outputs': 'Todas las salidas',
  'vault.plan.assets': 'Efectos sobre activos protegidos',
  'vault.plan.fee': 'Tarifa',
  'vault.plan.size': 'Tamaño (vbytes)',
  'vault.plan.inputs': 'Monedas usadas',
  'vault.plan.expires': 'Válida hasta',
  'vault.plan.stale': 'Esta transacción está desactualizada. Créala de nuevo antes de firmar.',
  'vault.plan.discard': 'Descartar',
  'vault.plan.sign': 'Firmar con este dispositivo',
  'vault.plan.signed': 'Firmada. Envía el texto de abajo al segundo firmante.',
  'vault.plan.psbt': 'Transacción para firmar (hex)',
  'vault.plan.peerPsbt': 'Texto devuelto por el segundo firmante (hex)',
  'vault.plan.mobileQrHeading': 'Solicita la aprobación independiente de Mobile B',
  'vault.plan.mobileQrBody':
    'Escanea en Mobile B la solicitud autenticada y el PSBT. Revísalos y firma allí; después escanea aquí los dos resultados.',
  'vault.plan.mobileContextQr': 'QR de solicitud de aprobación autenticada para Mobile B',
  'vault.plan.mobilePsbtQr': 'QR del PSBT de Vault',
  'vault.plan.mobileContextStep': '1. Escanea la solicitud autenticada',
  'vault.plan.mobilePsbtStep': '2. Escanea la transacción',
  'vault.plan.qrPart': 'Parte {index} de {count} del QR',
  'vault.plan.qrPause': 'Pausar QR',
  'vault.plan.qrResume': 'Reanudar QR',
  'vault.plan.scanMobileContext': 'Escanear resultado de Mobile B',
  'vault.plan.scanMobilePsbt': 'Escanear PSBT firmado',
  'vault.plan.mobileRequestHeading': 'Aprobar una transacción coordinada por Mobile',
  'vault.plan.mobileRequestBody':
    'Escanea la solicitud autenticada y el PSBT de Mobile B. Escritorio A vuelve a escanear Vault y reconstruye cada campo antes de firmar.',
  'vault.plan.scanMobileRequest': 'Escanear solicitud de Mobile B',
  'vault.plan.scanMobileRequestPsbt': 'Escanear PSBT de Mobile B',
  'vault.plan.signMobileRequest': 'Revisión completa — firmar como Escritorio A',
  'vault.plan.mobileRequestSigned': 'Escritorio A firmó la solicitud móvil verificada independientemente.',
  'vault.plan.mobileResultContextQr': 'QR del resultado de aprobación de Escritorio A',
  'vault.plan.mobileResultPsbtQr': 'QR del PSBT firmado por Escritorio A',
  'vault.plan.mobileResultContextStep': '1. Escanea la aprobación de Escritorio A',
  'vault.plan.mobileResultPsbtStep': '2. Escanea la transacción firmada de Escritorio A',
  'vault.plan.combine': 'Combinar firmas',
  'vault.plan.finalize': 'Terminar transacción',
  'vault.plan.finalized': 'Terminada. Revísala y luego envíala.',
  'vault.plan.transaction': 'Transacción terminada (hex)',
  'vault.plan.broadcast': 'Enviar',
  'vault.plan.broadcastState': 'Resultado del envío',
  'vault.plan.preparedResume': 'Estos bytes exactos de la transacción están preparados de forma duradera y pueden enviarse una sola vez.',
  'vault.plan.reconcileOnly': 'Es posible que esta transacción ya se haya enviado. No la reintentes ni la descartes; verifica en la cadena el identificador exacto.',
  'vault.plan.reconcile': 'Comprobar la transacción exacta en la cadena',
  'vault.plan.reconciled': 'Terminó la comprobación de la transacción exacta.',
  'vault.plan.txid': 'ID de la transacción',
  'vault.plan.deposit': 'Dirección de depósito de la Bóveda',
  'vault.plan.depositShow': 'Mostrar dirección de depósito',
  'vault.plan.depositBody':
    'Envía desde tu billetera de Gasto a esta dirección. Se regenera a partir de la política cada vez que se muestra; nunca se guarda.',

  'vault.error.recoveryCSessionMissing':
    'Ese desafío de Recuperación C ya no está abierto. Descarga uno nuevo y responde exactamente a ese archivo sin conexión.',
  'vault.error.recoveryCResponseRejected':
    'La respuesta de Recuperación C fue rechazada. Puede estar dañada, caducada, ser de otra Bóveda o red, o responder a un desafío anterior.',
  'vault.error.recoveryCKitRequired':
    'Guarda el kit público de recuperación antes de iniciar la comprobación de la copia en papel.',
  'vault.error.recoveryCBackupRequired':
    'La financiación y las transferencias permanecen bloqueadas hasta superar la comprobación sin conexión de la copia en papel.',
  'vault.recoveryC.heading': 'Preparación de Recuperación C sin conexión',
  'vault.recoveryC.summary':
    'Recuperación C es un voto de esta Bóveda 2 de 3. No puede gastar por sí sola ni es una copia de tu cartera de Gasto. Drey nunca crea, recibe ni guarda sus 12 palabras.',
  'vault.recoveryC.setupHeading': 'Crear Recuperación C sin conexión',
  'vault.recoveryC.setupBody':
    'Descarga un desafío público, llévalo a un ordenador de confianza desconectado de toda red y ejecuta allí la herramienta de recuperación independiente verificada. Solo su archivo público de respuesta vuelve a este ordenador.',
  'vault.recoveryC.prepareOffline': 'Prepara un ordenador de confianza y desconecta Wi-Fi, Ethernet y Bluetooth.',
  'vault.recoveryC.preparePaper': 'Prepara papel duradero y un bolígrafo para las 12 palabras de Recuperación C.',
  'vault.recoveryC.prepareSeparate': 'Guarda esas palabras separadas del kit público de recuperación.',
  'vault.recoveryC.preparePowerOff': 'Después de guardar la respuesta, apaga el ordenador sin conexión antes de volver a conectarlo.',
  'vault.recoveryC.setupStart': 'Descargar desafío de configuración',
  'vault.recoveryC.setupReplace': 'Reemplazar desafío de configuración',
  'vault.recoveryC.setupDownloaded':
    'Desafío descargado. Complétalo con la herramienta independiente en el ordenador sin conexión y elige aquí su archivo de respuesta.',
  'vault.recoveryC.setupCancelled': 'El desafío fue cancelado. Cualquier respuesta a él será rechazada.',
  'vault.recoveryC.setupInterrupted':
    'Un desafío anterior sigue abierto, pero esta página no conserva su descarga. Reemplázalo antes de continuar; la respuesta anterior será rechazada.',
  'vault.recoveryC.setupWaiting':
    'Esperando la respuesta pública sin conexión. Huella del desafío: {fingerprint}.',
  'vault.recoveryC.responseFile': 'Elegir el archivo público de respuesta',
  'vault.recoveryC.noFile': 'No se seleccionó ningún archivo. El desafío actual sigue abierto.',
  'vault.recoveryC.fileSize': 'El archivo está vacío o supera el límite de 64 KiB para registros públicos.',
  'vault.recoveryC.fileReadFailed': 'No se pudo leer el archivo seleccionado. El desafío actual sigue abierto.',
  'vault.recoveryC.downloadFailed': 'No se pudo descargar el archivo público del desafío. Inténtalo de nuevo antes de desconectarte.',
  'vault.recoveryC.setupComplete': 'Recuperación C fue verificada. Sus palabras permanecen solo en tu copia en papel.',
  'vault.recoveryC.stepSetup': '1. Crear y demostrar Recuperación C en el ordenador sin conexión.',
  'vault.recoveryC.stepSetupDone': '1. Firmante público de Recuperación C verificado.',
  'vault.recoveryC.stepKit': '2. Guardar el kit público separado de las palabras.',
  'vault.recoveryC.stepKitDone': '2. Kit público de recuperación guardado.',
  'vault.recoveryC.stepBackup':
    '3. Lleva el kit de recuperación guardado y el desafío de comprobación al ordenador sin conexión, vuelve a introducir las palabras del papel y devuelve la comprobación firmada.',
  'vault.recoveryC.stepBackupDone': '3. Comprobación de la copia en papel superada.',
  'vault.recoveryC.kitRequired':
    'Muestra el kit de recuperación abajo y descarga su archivo. Este archivo público revela todas las direcciones, así que protege su privacidad y mantenlo separado de las palabras.',
  'vault.recoveryC.kitDownloadStarted':
    'La descarga comenzó. Confirma solo después de ver el archivo del kit en una ubicación de almacenamiento separada.',
  'vault.recoveryC.kitConfirm': 'Guardé el kit por separado',
  'vault.recoveryC.kitComplete': 'Ubicación del kit confirmada. Ya puede comenzar la comprobación en papel.',
  'vault.recoveryC.backupStart': 'Descargar desafío de comprobación',
  'vault.recoveryC.backupReplace': 'Reemplazar desafío de comprobación',
  'vault.recoveryC.backupDownloaded':
    'Desafío descargado. Lleva el desafío y el kit de recuperación guardado al ordenador sin conexión, vuelve a introducir allí las 12 palabras del papel y devuelve solo el archivo público de respuesta.',
  'vault.recoveryC.backupWaiting':
    'Esperando la respuesta pública de comprobación. Huella del desafío: {fingerprint}.',
  'vault.recoveryC.fundingBlocked':
    'No financies esta Bóveda todavía. Las direcciones de depósito y todas las acciones que mueven valor permanecen bloqueadas hasta superar los tres pasos.',
  'vault.recoveryC.ready':
    'Recuperación C está lista. La copia en papel se comprobó contra esta política exacta de Bóveda.',
  'vault.recoveryC.unusable':
    'Las comprobaciones guardadas de Recuperación C no se pueden verificar. No financies ni transfieras. Si esta Bóveda está vacía con certeza, elimina su política y reinicia la configuración. Si puede contener fondos, conserva la política y usa dos roles verificados con la herramienta de recuperación independiente.',

  'vault.kit.download': 'Descargar archivo del kit',
  'vault.kit.print': 'Imprimir kit',
  'vault.kit.qr.show': 'Mostrar el kit como códigos QR',
  'vault.kit.qr.hide': 'Ocultar códigos QR',
  'vault.kit.qr.body':
    'Escanea todas las partes, en cualquier orden. Cada escaneo empieza con su número de parte; las partes juntas son el kit completo, y la herramienta de recuperación independiente las acepta unidas en orden y sin las etiquetas. Guarda el kit en un lugar seguro: no puede gastar, pero revela todas las direcciones de la Bóveda.',
  'vault.kit.qr.part': 'Parte {index} de {count}',
  'vault.kit.qr.alt': 'Código QR del kit de recuperación, parte {index} de {count}',

  'vault.transportScanner.open': 'Abrir escáner QR de Vault',
  'vault.transportScanner.scanOrigin': 'Escanear QR de identidad de Móvil B',
  'vault.transportScanner.scanResponseOne': 'Escanear respuesta 1 de 2 de Mobile B',
  'vault.transportScanner.scanResponseTwo': 'Escanear respuesta 2 de 2 de Mobile B',
  'vault.transportScanner.title': 'Escáner QR de Vault',
  'vault.transportScanner.body':
    'Los escaneos parciales se descartan al salir de primer plano o cancelar. Drey solo importa un contexto Vault completo y verificado o un PSBT estándar válido.',
  'vault.transportScanner.video': 'Vista previa para códigos QR de Vault',
  'vault.transportScanner.start': 'Iniciar cámara',
  'vault.transportScanner.resume': 'Reiniciar cámara',
  'vault.transportScanner.cancel': 'Detener cámara',
  'vault.transportScanner.scanning': 'Cámara activa. Decodificador local: {decoder}.',
  'vault.transportScanner.progress': 'Recibidos {received} de {expected} fotogramas QR de Vault.',
  'vault.transportScanner.duplicate': 'Ese fotograma ya se recibió. Sigue escaneando.',
  'vault.transportScanner.complete': 'QR de Vault reconstruido y verificado.',
  'vault.transportScanner.background': 'La cámara se detuvo al salir esta página del primer plano.',
  'vault.transportScanner.denied': 'Se denegó el acceso a la cámara. No se capturó nada.',
  'vault.transportScanner.unavailable': 'No hay una cámara utilizable disponible.',
  'vault.transportScanner.error.ambiguous': 'Hay más de un código QR visible. Muestra solo uno.',
  'vault.transportScanner.error.mixed': 'Ese fotograma pertenece a otra sesión de transporte.',
  'vault.transportScanner.error.tampered': 'Ese fotograma estaba dañado o modificado y fue rechazado.',
  'vault.transportScanner.error.type': 'Ese código QR no es del tipo Vault esperado para este paso.',
  'vault.transportScanner.error.unsupported': 'Ese tipo de fotograma fountain aún no es compatible.',
  'vault.transportScanner.error.invalid': 'Ese código QR no es un fotograma UR canónico y acotado.',
  'vault.transportScanner.error.generic': 'El fotograma de la cámara no se pudo procesar de forma segura.',

  'vault.tool.heading': 'Herramienta de recuperación independiente',
  'vault.tool.body':
    'Este kit identifica un programa sin conexión que puede abrir esta Bóveda con dos roles cualesquiera, sin Drey. Compara lo que descargaste con estos valores antes de confiar en él: si alguno no coincide, detente.',
  'vault.tool.source': 'Compilado desde',
  'vault.tool.artifact': 'Suma de comprobación del programa (SHA-256)',
  'vault.tool.reproduce':
    'Compílalo tú mismo: clona esa etiqueta y ejecuta pnpm install --frozen-lockfile && pnpm recovery:verify. Compila dos veces y falla si los bytes no coinciden.',

  'vault.pilot.noIndependence':
    'La custodia requiere independencia real. Mantén Escritorio A y Mobile B en dispositivos separados y crea Recuperación C solo con la ceremonia sin conexión verificada.',
};
