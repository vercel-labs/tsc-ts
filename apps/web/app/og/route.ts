import { homeOgTitle } from '@/lib/og-titles';
import { renderLabsOg } from './labs-og';

export async function GET() {
  return renderLabsOg({ product: 'tsc-ts', title: homeOgTitle });
}
