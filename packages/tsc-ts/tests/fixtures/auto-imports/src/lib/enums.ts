export enum Color { Red, Green, Blue }
export enum Mode { Read = 'r', Write = 'w', 'Read-Write' = 'rw' }
export const enum Flag { On = 1, Off = 0 }
export default enum Size { Small, Large }
export function color(): Color { return Color.Red; }
export function mode(): Mode { return Mode.Read; }
export function flag(): Flag { return Flag.On; }
export function size(): Size { return Size.Small; }
export function mixed(): Color.Red | Color.Green | 'none' | 3 { return 3; }
