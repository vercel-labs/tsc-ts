export function formatName(first: string, last: string): string {
  return `${first} ${last}`;
}
export class Greeter {
  greet(name: string): string {
    return 'Hello, ' + name;
  }
}
declare global {
  interface Window {
    greeter?: Greeter;
  }
}
