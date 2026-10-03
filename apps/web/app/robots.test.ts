import robots from './robots';
import sitemap from './sitemap';

test('robots allows the site and points at the sitemap on the bare domain', () => {
  expect(robots()).toEqual({
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://punxsyprominence.org/sitemap.xml',
  });
});

test('sitemap lists the public homepage and nothing else', () => {
  expect(sitemap()).toEqual([{ url: 'https://punxsyprominence.org/' }]);
});
