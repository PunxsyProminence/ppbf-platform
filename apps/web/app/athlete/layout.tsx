import { ReactNode } from 'react';

interface AthleteLayoutProps {
  children: ReactNode;
}

/**
 * Marks everything under /athlete as a gym-floor surface.
 *
 * Law 5 reserves --tap (55px) for the surfaces a child actually uses standing
 * up: gloved or wrapped hands, a cracked hand-me-down screen, a phone across
 * the room, and a room that is loud. The 44px WCAG floor is a desk number.
 *
 * ppbf.css has carried .btn--kiosk and .input--kiosk for this all along, and
 * they work -- /activate uses them throughout. But they are opt-in per control,
 * so an athlete surface is only as tall as the controls somebody remembered to
 * mark, and the sweeps kept finding ones nobody had. AthleteWorkspace's
 * session-duration input sat at 36px on a screen a child taps between rounds.
 *
 * This is the container the whole athlete section already passes through, so
 * the floor applies to what is there now and to whatever gets added next.
 *
 * `display: contents` deliberately: this element must mark its subtree without
 * appearing in layout, or every athlete page would gain a box it was not
 * designed inside. The attribute is a hook, not a wrapper.
 */
export default function AthleteLayout({ children }: AthleteLayoutProps) {
  return (
    <div data-surface="kiosk" className="contents">
      {children}
    </div>
  );
}

// Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
