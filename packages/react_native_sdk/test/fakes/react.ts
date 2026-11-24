// Stands in for the `react` module in tests (see vitest.config.ts): just enough of the hooks
// runtime to drive a custom hook through mount, re-render, dependency change and unmount.
// It is not React; behaviour inside a real React tree is not covered by these tests.
import type { HooksLike } from '../../src/hook.js';

interface EffectSlot {
  deps: readonly unknown[] | undefined;
  cleanup: void | (() => void);
}

interface Instance {
  refs: { current: unknown }[];
  effects: EffectSlot[];
  queued: { index: number; effect: () => void | (() => void) }[];
  cursor: { ref: number; effect: number };
}

let current: Instance | null = null;

function active(): Instance {
  if (current === null) throw new Error('Hooks can only be called while rendering');
  return current;
}

export const useRef: HooksLike['useRef'] = <T>(initial: T) => {
  const instance = active();
  const index = instance.cursor.ref++;
  instance.refs[index] ??= { current: initial };
  return instance.refs[index] as { current: T };
};

export const useEffect: HooksLike['useEffect'] = (effect, deps) => {
  const instance = active();
  const index = instance.cursor.effect++;
  const slot = instance.effects[index];
  const changed =
    slot === undefined ||
    deps === undefined ||
    slot.deps === undefined ||
    deps.length !== slot.deps.length ||
    deps.some((dep, i) => !Object.is(dep, slot.deps?.[i]));
  if (slot === undefined) instance.effects[index] = { deps, cleanup: undefined };
  else slot.deps = deps;
  if (changed) instance.queued.push({ index, effect });
};

export interface Rendered<P> {
  rerender(props: P): void;
  unmount(): void;
}

/** Renders a "component" (a function that calls hooks) and runs its effects like React does. */
export function render<P>(component: (props: P) => void, props: P): Rendered<P> {
  const instance: Instance = { refs: [], effects: [], queued: [], cursor: { ref: 0, effect: 0 } };

  const run = (next: P): void => {
    instance.cursor = { ref: 0, effect: 0 };
    instance.queued = [];
    current = instance;
    try {
      component(next);
    } finally {
      current = null;
    }
    // Like React: all cleanups of changed effects first, then the effects, in order.
    for (const { index } of instance.queued) {
      const slot = instance.effects[index] as EffectSlot;
      slot.cleanup?.();
      slot.cleanup = undefined;
    }
    for (const { index, effect } of instance.queued) {
      (instance.effects[index] as EffectSlot).cleanup = effect();
    }
  };

  run(props);
  return {
    rerender: run,
    unmount() {
      for (const slot of instance.effects) {
        slot.cleanup?.();
        slot.cleanup = undefined;
      }
    },
  };
}
