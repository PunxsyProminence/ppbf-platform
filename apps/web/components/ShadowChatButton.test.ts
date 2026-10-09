import { buttonClasses } from './ShadowChatButton';

/* Law 5, OD-2026-10-02-004/-007: every tap target is 55px (--tap). This
   button was min-h-[44px], the desk floor, on every page that shows it. */
test('holds the 55px tap floor, not the 44px desk floor', () => {
  const classes = buttonClasses();

  expect(classes).toContain('min-h-[var(--tap)]');
  expect(classes).not.toContain('44px');
});
