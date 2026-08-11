/** Spanish catalog for the extension-only passkey strings (see passkey-en.ts). */
import type { PasskeyMessageKey } from './passkey-en';

export const passkeyEs: Record<PasskeyMessageKey, string> = {
  'passkey.error.duplicate': 'Esta llave de acceso ya está configurada para esta cartera.',
  'passkey.error.mismatch': 'Este registro de llave de acceso no pertenece a esta cartera o a esta versión.',
  'passkey.error.invalidPrf':
    'La llave de acceso no devolvió material de clave utilizable. Usa tu contraseña.',
  'passkey.error.unavailable': 'El desbloqueo con llave de acceso no está disponible aquí. Usa tu contraseña.',

  'passkey.unlock.button': 'Desbloquear con una llave de acceso',
  'passkey.unlock.failed': 'El desbloqueo con llave de acceso no funcionó. Introduce tu contraseña.',
  'passkey.onboarding.passwordNote': 'Después de guardar una copia de esta cartera, puedes configurar el desbloqueo opcional con llave de acceso.',
  'passkey.onboarding.title': 'Desbloquea más rápido con una llave de acceso',
  'passkey.onboarding.body': 'Opcional: usa Touch ID, tu dispositivo o una llave de seguridad para desbloquear. Tu contraseña sigue funcionando. Una llave de acceso no puede recuperar esta cartera.',
  'passkey.onboarding.setup': 'Configurar llave de acceso',
  'passkey.onboarding.skip': 'Ahora no',

  'settings.passkeys.entry': 'Desbloqueo con llave de acceso',

  'passkey.settings.title': 'Desbloqueo con llave de acceso',
  'passkey.settings.intro':
    'Una llave de acceso (por ejemplo Touch ID o una llave de seguridad) puede desbloquear esta cartera sin escribir tu contraseña. Es opcional: tu contraseña siempre funciona, y una llave de acceso nunca sustituye a tu frase de recuperación.',
  'passkey.settings.none': 'No hay llaves de acceso configuradas para esta cartera.',
  'passkey.settings.added': 'Añadida el {date}',
  'passkey.settings.add': 'Añadir una llave de acceso',
  'passkey.settings.add.body':
    'Introduce tu contraseña para añadir una llave de acceso. Tu navegador te pedirá verificarte dos veces: una para crear la llave y otra para confirmar que puede desbloquear esta cartera.',
  'passkey.settings.label': 'Nombre de la llave',
  'passkey.settings.defaultLabel': 'Llave de acceso',
  'passkey.settings.rename': 'Renombrar',
  'passkey.settings.save': 'Guardar',
  'passkey.settings.remove': 'Quitar',
  'passkey.settings.remove.body':
    'Introduce tu contraseña para quitar esta llave de acceso de Drey. Dejará de desbloquear esta cartera. Esto no elimina la llave de tu dispositivo ni de su sincronización en la nube: gestiónalas en el administrador de credenciales de tu sistema.',
  'passkey.settings.removed': 'Llave de acceso eliminada.',
  'passkey.settings.unsupported':
    'Este navegador o dispositivo no puede crear una llave de acceso con la derivación de claves (PRF) necesaria.',
  'passkey.settings.prfMissing':
    'Este autenticador no puede usarse: no admite la derivación de claves (PRF) necesaria. Drey no guardó nada, pero puede que se haya creado una llave de acceso; puedes eliminarla en el administrador de credenciales de tu sistema.',
  'passkey.settings.verifyFailed':
    'No se pudo confirmar la nueva llave de acceso, así que Drey no guardó nada. Puede que se haya creado una llave de acceso; puedes eliminarla en el administrador de credenciales de tu sistema.',
  'passkey.settings.invalid.notice':
    '{count} registro(s) de llave de acceso almacenado(s) no pueden usarse con esta cartera o versión.',
  'passkey.settings.invalid.purge': 'Quitar registros inutilizables',
};
