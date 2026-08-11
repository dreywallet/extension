import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { makeRpc, type Rpc } from '../../adapters/rpc-client';
import type { SenderContext } from '@drey/core/messaging/envelope';

const RpcContext = createContext<Rpc | null>(null);

/** Each entrypoint declares its own sender context exactly once, at the root. */
export function RpcProvider(props: { sender: SenderContext; children: ReactNode }): ReactNode {
  const rpc = useMemo(() => makeRpc(props.sender), [props.sender]);
  return createElement(RpcContext.Provider, { value: rpc }, props.children);
}

export function useRpc(): Rpc {
  const ctx = useContext(RpcContext);
  if (!ctx) throw new Error('useRpc outside RpcProvider');
  return ctx;
}
