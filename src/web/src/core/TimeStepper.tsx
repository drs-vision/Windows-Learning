import { BLOCK_MINUTES } from './types';

/** The arcade-style "+ / −" control: each + adds 5 minutes. Shared by the arcade and YouTube. */
export function TimeStepper({ price, blocks, setBlocks, min = 1, max = 12, balance, more }: {
  price: number; blocks: number; setBlocks: (n: number) => void; min?: number; max?: number; balance: number; more?: boolean;
}) {
  return (
    <div class="stepper">
      <button class="step" disabled={blocks <= min} onClick={() => setBlocks(blocks - 1)} aria-label="less time">−</button>
      <div class="step-time"><b>{blocks * BLOCK_MINUTES}</b><small>{more ? 'more min' : 'min'}</small></div>
      <button class="step plus" disabled={blocks >= max || balance < price * (blocks + 1)} onClick={() => setBlocks(blocks + 1)} aria-label="more time">+</button>
      <div class="step-cost">🪙 {price * blocks}</div>
    </div>
  );
}
