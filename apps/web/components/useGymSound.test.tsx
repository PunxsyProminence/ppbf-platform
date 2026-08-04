/**
 * @jest-environment jsdom
 */

// Two promises this hook makes, both worth pinning because breaking either is
// silent: sound is OFF until somebody asks (rule 1 of the design system's sound
// engine), and nothing here ever throws — a browser with no Web Audio, or a
// kiosk webview that refuses to start it, has to degrade to silence and an
// honest label rather than to an error in front of a child mid-session.
//
// jsdom has no AudioContext, which makes it exactly the "locked-down kiosk"
// case by default.

import { act, render, screen } from '@testing-library/react';

import useGymSound, { playGymSound, resetGymSoundForTests, setGymSoundEnabled } from './useGymSound';
import SoundToggle from './SoundToggle';

function Probe() {
  const { enabled, ready, status } = useGymSound();
  return <p data-testid="probe">{`${status}/${String(enabled)}/${String(ready)}`}</p>;
}

beforeEach(() => {
  window.localStorage.clear();
  resetGymSoundForTests();
});

it('loads the design system engine as a global, not as a module export', () => {
  // ppbf-sound.js is a classic script on purpose — browsers block `import`
  // over file://, and every preview in that folder opens by double-clicking it
  // off disk. Importing it for the side effect is the documented usage.
  expect(typeof (globalThis as { PPBFSound?: unknown }).PPBFSound).toBe('function');
});

it('is off before anybody asks, and constructs no audio to find that out', () => {
  render(<Probe />);
  expect(screen.getByTestId('probe').textContent).toBe('off/false/false');
  expect(window.localStorage.getItem('ppbf.sound.enabled')).toBeNull();
});

it('plays nothing, and returns false, while sound is off', () => {
  render(<Probe />);
  for (const voice of ['bell', 'stamp', 'latch', 'accept', 'refuse'] as const) {
    expect(playGymSound(voice)).toBe(false);
  }
});

it('says audio is unavailable rather than showing an on switch that does nothing', async () => {
  // No AudioContext in jsdom: the engine's enable() catches it and reports
  // failure, and the control has to repeat that honestly.
  render(<Probe />);
  await act(async () => {
    await setGymSoundEnabled(true);
  });

  expect(screen.getByTestId('probe').textContent).toBe('unavailable/true/false');
  expect(playGymSound('bell')).toBe(false);
});

it('reports a stored preference as waiting, not as live, until the page is touched', () => {
  // A preference is consent. It is not a user gesture, and no browser starts
  // audio without one.
  window.localStorage.setItem('ppbf.sound.enabled', '1');
  render(<Probe />);
  expect(screen.getByTestId('probe').textContent).toBe('arming/true/false');
});

it('shares one engine and one state across every component that asks', async () => {
  render(<><Probe /><Probe /></>);
  const [first, second] = screen.getAllByTestId('probe');
  expect(first.textContent).toBe(second.textContent);

  await act(async () => {
    await setGymSoundEnabled(true);
  });

  expect(first.textContent).toBe('unavailable/true/false');
  expect(second.textContent).toBe(first.textContent);
});

it('writes the preference off when it is switched off, even with no engine built', async () => {
  window.localStorage.setItem('ppbf.sound.enabled', '1');
  render(<Probe />);
  await act(async () => {
    await setGymSoundEnabled(false);
  });

  expect(screen.getByTestId('probe').textContent).toBe('off/false/false');
  expect(window.localStorage.getItem('ppbf.sound.enabled')).toBe('0');
});

describe('the opt-in control', () => {
  it('names its state in words and in a glyph, never in colour alone', () => {
    render(<SoundToggle />);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Sound off');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('says so plainly when this browser will not give it audio', async () => {
    render(<SoundToggle />);
    const button = screen.getByRole('button');

    await act(async () => {
      button.click();
    });

    // Not "Sound on". jsdom has no Web Audio, and neither does a locked-down
    // kiosk webview.
    expect(button.textContent).toContain('No audio');
  });
});
