/**
 * The Vault coordinator's form modes, as data rather than as four parallel
 * switch statements.
 *
 * C0-C1 grew this into `formTitle`, `formBody`, `submitLabel`, and a
 * `passwordModes` set, each of which had to be edited in step for every new
 * mode and each of which could silently disagree with the others — a mode
 * missing from `passwordModes` renders a ceremony with no password field and a
 * submit button that always fails. One table means adding a mode is one edit,
 * and a mode that is not in the table is a type error rather than a form
 * captioned "Delete this role".
 */
import type { MessageKey } from '../../../ui/i18n';

/** Every mode the coordinator's single form can be in. `view` renders no form. */
export type VaultModeKind =
  | 'view'
  | 'create'
  | 'restore'
  | 'reveal'
  | 'remove'
  | 'purge'
  | 'import'
  | 'createPolicy'
  | 'removePolicy'
  | 'purgePolicy';

export type VaultFormMode = Exclude<VaultModeKind, 'view'>;

export interface VaultModeSpec {
  title: MessageKey;
  body: MessageKey;
  submit: MessageKey;
  /**
   * Whether this ceremony reauthenticates. True wherever a secret is created,
   * read, or destroyed — role A's record has its own key, so opening it costs a
   * password every time, and removal restates what is being lost.
   */
  needsPassword: boolean;
  /** Whether a free-text label is collected before the ceremony runs. */
  needsLabel: boolean;
}

export const VAULT_MODE_SPECS: Readonly<Record<VaultFormMode, VaultModeSpec>> = {
  create: {
    title: 'vault.create.title',
    body: 'vault.create.body',
    submit: 'vault.create.submit',
    needsPassword: true,
    needsLabel: true,
  },
  restore: {
    title: 'vault.restore.title',
    body: 'vault.restore.body',
    submit: 'vault.restore.submit',
    needsPassword: true,
    needsLabel: true,
  },
  reveal: {
    title: 'vault.reveal.title',
    body: 'vault.reveal.body',
    submit: 'vault.reveal.submit',
    needsPassword: true,
    needsLabel: false,
  },
  remove: {
    title: 'vault.remove.title',
    body: 'vault.remove.body',
    submit: 'vault.remove.submit',
    needsPassword: true,
    needsLabel: false,
  },
  purge: {
    title: 'vault.remove.title',
    body: 'vault.remove.body',
    submit: 'vault.remove.submit',
    needsPassword: true,
    needsLabel: false,
  },
  // The one ceremony with no password: importing a peer origin and verifying
  // its proof of possession are pure public-key operations.
  import: {
    title: 'vault.import.title',
    body: 'vault.import.body',
    submit: 'vault.import.submit',
    needsPassword: false,
    needsLabel: false,
  },
  createPolicy: {
    title: 'vault.policy.create.title',
    body: 'vault.policy.create.body',
    submit: 'vault.policy.create.submit',
    needsPassword: true,
    needsLabel: true,
  },
  removePolicy: {
    title: 'vault.policy.remove.title',
    body: 'vault.policy.remove.body',
    submit: 'vault.policy.remove.submit',
    needsPassword: true,
    needsLabel: false,
  },
  purgePolicy: {
    title: 'vault.policy.remove.title',
    body: 'vault.policy.remove.body',
    submit: 'vault.policy.remove.submit',
    needsPassword: true,
    needsLabel: false,
  },
};
