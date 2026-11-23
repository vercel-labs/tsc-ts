import { defineConfig } from '@vercel/geistdocs/config';

export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);

export const config = defineConfig({
  title: 'tsc-ts',
  siteUrl,
  defaultLanguage: 'en',
  logo: (
    <span
      className="font-semibold"
      style={{
        fontFamily: 'var(--font-geist-sans)',
        fontSize: '24.4px',
        letterSpacing: '-0.05em',
        lineHeight: 1,
        transform: 'translateY(-0.5px)',
      }}
    >
      tsc-ts
    </span>
  ),
  navbarActiveProduct: 'tsc-ts',
  navbarBrand: 'labs',
  github: { owner: 'vercel-labs', repo: 'tsc-ts', branch: 'main', editPath: 'apps/web/content/docs' },
  content: [{ id: 'docs', label: 'Documentation', dir: 'content/docs', route: '/' }],
  nav: [{ label: 'Compiler', href: '/compiler' }],
  ai: { enabled: false },
  feedback: { enabled: false },
  language: { enabled: false },
  pageActions: { askAI: false, openInChat: false, copyPage: true },
});
