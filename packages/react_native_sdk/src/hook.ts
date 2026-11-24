import type { LinkListener, Strybok } from '@strybok/js';

/** The React hooks this package uses, typed structurally (see peer-modules.d.ts). */
export interface HooksLike {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initial: T): { current: T };
}

/** What the hook needs from a `Strybok` instance. */
export type StrybokLike = Pick<Strybok, 'onLink' | 'initialize'>;

export type UseStrybokLink = (strybok: StrybokLike, onLink: LinkListener) => void;

/** Builds {@link UseStrybokLink} on the given hooks; the package entry passes React's. */
export function createUseStrybokLink({ useEffect, useRef }: HooksLike): UseStrybokLink {
  return function useStrybokLink(strybok, onLink) {
    // Always call the latest callback without re-subscribing on every render.
    const latest = useRef(onLink);
    useEffect(() => {
      latest.current = onLink;
    });

    useEffect(() => {
      const unsubscribe = strybok.onLink((link) => latest.current(link));
      // Idempotent. It rejects only for a disposed instance, which has nothing to deliver.
      strybok.initialize().catch(() => {});
      return unsubscribe;
    }, [strybok]);
  };
}
