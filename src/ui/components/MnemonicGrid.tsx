import type { ReactNode } from 'react';
import styles from './MnemonicGrid.module.css';

/**
 * Displays a recovery phrase (§7.1/§7.6). No copy affordance by design: text
 * selection is disabled and copy events are cancelled — the complete mnemonic
 * must never reach the clipboard.
 */
export function MnemonicGrid(props: { words: readonly string[]; masked?: boolean }): ReactNode {
  return (
    <ol
      className={styles['grid']}
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      aria-hidden={props.masked === true || undefined}
    >
      {props.words.map((word, i) => (
        <li key={i} className={styles['word']}>
          <span className={styles['index']}>{i + 1}</span>
          <span className={props.masked === true ? styles['masked'] : undefined}>
            {props.masked === true ? '••••' : word}
          </span>
        </li>
      ))}
    </ol>
  );
}
