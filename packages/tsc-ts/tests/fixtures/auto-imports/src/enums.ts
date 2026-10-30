import { color, mode, flag, size, mixed, Color } from './lib/enums';
namespace Outer { export enum Deep { One = 1, Two, '3d' } }
enum Dup { A = 1, B = 1, C = 2 }
declare const deep: Outer.Deep;
declare const dup: Dup;
declare const either: Dup | Outer.Deep;
switch (color()) {
  case Color.Green:
  
}
switch (mode()) {
  
}
switch (flag()) {
  
}
switch (size()) {
  
}
switch (mixed()) {
  
}
switch (deep) {
  
}
switch (dup) {
  
}
switch (either) {
  case 2:
  
}
