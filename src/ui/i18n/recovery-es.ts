import type { RecoveryMessageKey } from './recovery-en';

export const recoveryEs: Record<RecoveryMessageKey, string> = {
  'recovery.platform.randomSource':
    'Fuente de aleatoriedad: el generador aleatorio criptográficamente seguro de este navegador (Web Crypto).',
  'recovery.forgot.link': '¿Olvidaste la contraseña?',
  'recovery.forgot.title': '¿Olvidaste tu contraseña?',
  'recovery.forgot.body':
    'Nadie puede restablecer ni recuperar tu contraseña de la app, ni siquiera Drey. Nunca sale de este dispositivo. Tus bitcoin están a salvo mientras tengas tu frase de recuperación.',
  'recovery.forgot.stepsTitle': 'Para empezar de nuevo con tu frase de recuperación:',
  'recovery.forgot.step1': 'Haz clic derecho en el icono de Drey en la barra del navegador y elige Quitar de Chrome.',
  'recovery.forgot.step2': 'Vuelve a instalar Drey desde Chrome Web Store.',
  'recovery.forgot.step3': 'Elige Restaurar una cartera e introduce tu frase de recuperación.',
  'recovery.forgot.warning':
    'Quitar Drey borra todas las carteras de este dispositivo. Hazlo solo si tienes la frase de recuperación de cada una y, si usas Drey Vault, tu kit de recuperación del Vault.',
  'recovery.forgot.back': 'Volver a desbloquear',
};
