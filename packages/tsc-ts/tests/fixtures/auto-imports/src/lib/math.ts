export default function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
export const PI_SQUARED = Math.PI * Math.PI;
export interface Vector {
  x: number;
  y: number;
}
export type Scalar = number;
export enum Direction {
  Up,
  Down,
}
