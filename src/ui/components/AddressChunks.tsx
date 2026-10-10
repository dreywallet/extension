import type { ReactNode } from 'react';
import styles from './AddressChunks.module.css';

/** Splits an address into groups of four so people can compare it by eye. */
export function addressChunks(address: string): string[] {
  return address.match(/.{1,4}/gu) ?? [];
}

/**
 * An address shown in groups of four. The groups are separated by spacing,
 * not by characters, so the element's text — and anything selected and
 * copied from it — is still the exact address.
 */
export function AddressChunks(props: {
  address: string;
  className?: string | undefined;
  testId?: string | undefined;
}): ReactNode {
  const className = props.className === undefined
    ? styles['address']
    : `${styles['address']} ${props.className}`;
  return (
    <span className={className} data-testid={props.testId} title={props.address}>
      {addressChunks(props.address).map((chunk, index) => (
        <span className={styles['group']} key={index}>{chunk}</span>
      ))}
    </span>
  );
}
