import { MobileDocsBar } from '@vercel/geistdocs/mobile-docs-bar';
import { createDocsPage } from '@vercel/geistdocs/pages/docs';
import { config } from '@/lib/geistdocs/config';
import { geistdocsSource } from '@/lib/geistdocs/source';

function ogImage(pageUrl: string, title: string) {
  return {
    url: pageUrl === '/' ? '/og' : `/og${pageUrl}`,
    width: 1200,
    height: 630,
    type: 'image/png',
    alt: title,
  };
}

const docsPage = createDocsPage({
  config,
  source: geistdocsSource,
  metadata: ({ metadata, page }) => {
    const title = page.data.title ?? config.title;
    const description = page.data.description;
    const image = ogImage(page.url, title);

    return {
      ...metadata,
      openGraph: {
        type: 'website',
        siteName: config.title,
        title,
        description,
        images: [image],
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [image],
      },
    };
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
