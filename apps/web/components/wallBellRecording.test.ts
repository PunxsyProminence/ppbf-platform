import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE TV'S BELL RECORDING (issue 1792 item 4; Jason, "A: Free boxing-bell recording (Rec.)" and
 * "A: Download #1 (Rec.)"). WallDisplay asks the sound engine for /sounds/boxing-bell.wav; this pins
 * that the file there is the one Jason approved, still a WAV short enough not to hold the engine
 * busy past a round's next bell, and that its CC0 provenance ships beside it.
 */
const SOUNDS = path.resolve(__dirname, '../public/sounds');

describe('the bell the TV rings', () => {
  const wav = readFileSync(path.join(SOUNDS, 'boxing-bell.wav'));

  it('is the approved Commons file, byte for byte', () => {
    expect(wav.length).toBe(306_592);
    expect(createHash('sha256').update(wav).digest('hex')).toBe('53b462aba98704d034a703892d0eba2bbd1bb5d65d4c7441894fc57c800a60cf');
  });

  it('is a PCM WAV of under four seconds', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    const byteRate = wav.readUInt32LE(28);
    const seconds = (wav.length - 44) / byteRate;
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(4);
  });

  it('ships with its CC0 credit', () => {
    const credits = readFileSync(path.join(SOUNDS, 'CREDITS.txt'), 'utf8');
    expect(credits).toContain('File:Dingdingding.wav');
    expect(credits).toContain('CC0 1.0');
  });
});
