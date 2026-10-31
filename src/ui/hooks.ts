import { useEffect, useState } from 'preact/hooks';
import type { Store } from '../state/store';

/** Store の現在値を購読する Preact フック。 */
export function useStore<T extends object>(store: Store<T>): T {
  const [state, setState] = useState(store.get());
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}
