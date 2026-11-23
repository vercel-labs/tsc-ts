import { NextResponse } from 'next/server';
import { source } from '@/lib/geistdocs/source';
import { renderLabsOg } from '../labs-og';

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug, 'en');

  if (!page) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return renderLabsOg({ product: 'tsc-ts', title: page.data.title ?? 'tsc-ts' });
}
