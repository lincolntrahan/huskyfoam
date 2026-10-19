import { machines } from '../src/core/presets';
import type { MachinePreset } from '../src/core/types';

/**
 * The machine the golden fixtures were made on: the shop machine's axes and G-code format with
 * the original 36 in carriage spacing, travel and home. Kept fixed so the real shop numbers can change.
 */
export const testMachine: MachinePreset = {
  ...machines.find((m) => m.id === 'shop-4axis')!,
  carriageSpacing: 36,
  travel: { x: [0, 40], y: [0, 20] },
  home: { x: 4.005, y: 0.164 },
};
