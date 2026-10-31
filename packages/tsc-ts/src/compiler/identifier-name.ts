import type { ProgramLifetime } from '@scriptc/types';

/**
 * The text of an identifier. The identifiers a parser's scanner interns with the same text share one
 * (scanner.ts `IdentifierTable`), and natively an identifier refers to it in 4 bytes.
 */
export class IdentifierName implements ProgramLifetime {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}
