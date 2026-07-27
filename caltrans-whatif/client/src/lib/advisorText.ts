/**
 * Text helpers for rendering advisor responses.
 *
 * Separate from AdvisorPanel.tsx so that file exports only components — Vite's fast refresh
 * cannot preserve state across edits in a module that mixes components with other exports.
 */

/**
 * Fence tag the model wraps structured recommendations in.
 * Mirrors `RECOMMENDATION_FENCE` in server/advisor/prompt.ts.
 */
export const RECOMMENDATION_FENCE = 'caltrans-recommendations';

/** Human labels for the closed `action_type` vocabulary (see server/advisor/prompt.ts). */
export const ACTION_LABELS: Record<string, string> = {
  ramp_metering: 'Ramp metering',
  lane_reversal: 'Lane reversal',
  incident_clearance_priority: 'Incident clearance priority',
  signal_retiming: 'Signal retiming',
  demand_shift_messaging: 'Demand shift / messaging',
  speed_harmonization: 'Speed harmonization',
  shoulder_running: 'Shoulder running',
  transit_diversion: 'Transit diversion',
  other: 'Other',
};

/**
 * Hide the recommendation block from the prose view.
 *
 * During streaming the JSON arrives character by character and would otherwise flash on screen
 * as raw text; once the turn completes the structured cards render it properly, so showing it
 * twice is noise. Matches an UNCLOSED fence too, which is the mid-stream state.
 */
export function stripRecommendationFence(text: string): string {
  const open = new RegExp('```[ \\t]*' + RECOMMENDATION_FENCE, 'i');
  const m = open.exec(text);
  if (!m) return text;
  const close = text.indexOf('```', m.index + m[0].length);
  return (
    close === -1 ? text.slice(0, m.index) : text.slice(0, m.index) + text.slice(close + 3)
  ).trimEnd();
}
