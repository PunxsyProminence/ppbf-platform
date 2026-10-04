import robots from './robots';
import sitemap from './sitemap';

test('robots allows the site and points at the sitemap on the www address', () => {
  expect(robots()).toEqual({
    rules: { userAgent: '*', allow: '/' },
    sitemap: 'https://www.punxsyprominence.org/sitemap.xml',
  });
});

test('sitemap lists the public homepage and the privacy notice, and nothing else', () => {
  expect(sitemap()).toEqual([
    { url: 'https://www.punxsyprominence.org/' },
    { url: 'https://www.punxsyprominence.org/privacy' },
  ]);
});
