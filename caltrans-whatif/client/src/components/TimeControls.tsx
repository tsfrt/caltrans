import { Button, Slider } from '@databricks/appkit-ui/react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { BUCKETS_PER_DAY, bucketToLocalTime } from '../lib/frames';
import type { AnimationClock } from '../lib/useAnimationClock';

export interface TimeControlsProps {
  clock: AnimationClock;
}

/** Rush-hour markers, drawn on the scrubber so the peaks are findable without scrubbing. */
const RUSH_MARKS = [
  { bucket: 28, label: '07:00' },
  { bucket: 68, label: '17:00' },
];

const SPEEDS = [
  { label: '1x', value: 3 },
  { label: '2x', value: 6 },
  { label: '4x', value: 12 },
];

/**
 * Play/pause + 15-minute-bucket scrubber over one Pacific-local day.
 *
 * The displayed clock is PACIFIC LOCAL time, derived from bucket_idx which
 * traffic_time_matrix.sql computes via from_utc_timestamp(..., 'America/Los_Angeles').
 * Showing UTC here would put the AM peak at 14:00 and make the demo look wrong.
 */
export function TimeControls({ clock }: TimeControlsProps) {
  const localTime = bucketToLocalTime(clock.bucket);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="icon"
          onClick={() => clock.step(-1)}
          aria-label="Step back 15 minutes"
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="default"
          size="icon"
          onClick={clock.toggle}
          aria-label={clock.playing ? 'Pause' : 'Play'}
          data-testid="play-toggle"
        >
          {clock.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={() => clock.step(1)}
          aria-label="Step forward 15 minutes"
        >
          <SkipForward className="h-4 w-4" />
        </Button>

        {/* These controls sit on a black/70 overlay, so the colour must NOT come from the
            theme: `text-foreground` resolves to near-black in the light theme and the clock
            was rendering invisible against the dark panel. Pinned to white explicitly. */}
        <div className="ml-2 font-mono text-2xl tabular-nums text-white" data-testid="clock-readout">
          {localTime}
          <span className="ml-1 text-xs text-white/60">PT</span>
        </div>

        <div className="ml-auto flex gap-1">
          {SPEEDS.map((s) => (
            <Button
              key={s.label}
              variant={clock.speed === s.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => clock.setSpeed(s.value)}
            >
              {s.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="relative pt-1">
        <Slider
          min={0}
          max={BUCKETS_PER_DAY - 1}
          step={1}
          value={[clock.bucket]}
          onValueChange={(v: number[]) => clock.seek(v[0])}
          aria-label="Time of day"
        />
        {/* Rush-hour ticks positioned proportionally along the track. */}
        <div className="relative mt-1 h-4">
          {RUSH_MARKS.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => clock.seek(m.bucket)}
              className="absolute -translate-x-1/2 text-[10px] text-amber-500 hover:text-amber-400"
              style={{ left: `${(m.bucket / (BUCKETS_PER_DAY - 1)) * 100}%` }}
              title={`Jump to ${m.label} peak`}
            >
              ▲ {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
