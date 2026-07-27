import { useCallback, useEffect, useRef, useState } from 'react';
import { BUCKETS_PER_DAY } from './frames';

/**
 * requestAnimationFrame-driven playback clock.
 *
 * Holds a FRACTIONAL bucket position (e.g. 68.37), not an integer frame. That is what
 * lets the map interpolate between the two neighbouring 15-minute buckets and read as
 * continuous motion rather than 96 discrete jumps. rAF also self-throttles to the
 * display refresh rate and pauses in background tabs, which an interval would not.
 *
 * Deliberately holds NO data and issues NO fetches -- it only advances a number. All
 * data is already in memory (see lib/frames.ts).
 */
export interface AnimationClock {
  /** Fractional bucket position in [0, 96). */
  position: number;
  /** Integer bucket for indexing (floor of position). */
  bucket: number;
  /** Fraction into the next bucket, [0, 1). */
  fraction: number;
  playing: boolean;
  /** Buckets advanced per real second. */
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Jump to an absolute (possibly fractional) bucket. */
  seek: (bucket: number) => void;
  step: (delta: number) => void;
  setSpeed: (bucketsPerSecond: number) => void;
}

export function useAnimationClock(initialBucket = 28, initialSpeed = 6): AnimationClock {
  const [position, setPosition] = useState(initialBucket);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(initialSpeed);

  // speedRef mirrors `speed` so the rAF loop can read the current value without listing
  // `speed` as an effect dependency -- doing so would tear down and recreate the loop on
  // every speed change, resetting lastTs and visibly stuttering playback.
  // The mirror is written in an effect, not during render: mutating a ref during render
  // is a React correctness violation (react-hooks/refs) because renders can be discarded.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      lastTsRef.current = null;
      return;
    }

    const tick = (ts: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last !== null) {
        const dtSeconds = (ts - last) / 1000;
        // Guard against a huge dt after a tab regains focus, which would teleport the
        // playhead across the whole day in one frame.
        const clamped = Math.min(dtSeconds, 0.25);
        setPosition((p) => (p + clamped * speedRef.current) % BUCKETS_PER_DAY);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [playing]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);

  const seek = useCallback((bucket: number) => {
    // Positive modulo so seeking backwards past 0 wraps to the end of the day.
    setPosition(((bucket % BUCKETS_PER_DAY) + BUCKETS_PER_DAY) % BUCKETS_PER_DAY);
  }, []);

  const step = useCallback((delta: number) => {
    setPlaying(false);
    setPosition((p) => {
      const next = Math.round(p) + delta;
      return ((next % BUCKETS_PER_DAY) + BUCKETS_PER_DAY) % BUCKETS_PER_DAY;
    });
  }, []);

  const setSpeed = useCallback((bucketsPerSecond: number) => {
    setSpeedState(bucketsPerSecond);
  }, []);

  const bucket = Math.floor(position);
  return {
    position,
    bucket,
    fraction: position - bucket,
    playing,
    speed,
    play,
    pause,
    toggle,
    seek,
    step,
    setSpeed,
  };
}
