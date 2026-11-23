import { renderLabsOg } from './labs-og';

const homeTitle = 'A TypeScript compiler written in TypeScript';

export async function GET() {
  return renderLabsOg({ product: 'tsc-ts', title: homeTitle });
}
