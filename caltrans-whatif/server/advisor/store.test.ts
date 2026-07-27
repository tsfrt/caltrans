/**
 * Tests for the Lakebase persistence layer and the recommendation parser.
 *
 * These run against a fake `Db` rather than Postgres, so what they pin is the thing that
 * actually breaks in review: the **SQL text and parameter order**. A transposed parameter or a
 * missing `::jsonb` cast is invisible in a type check and fails only at runtime, in the
 * deployed app. (Real Postgres behaviour — cascades, constraints, grants — is verified
 * separately against the live instance; see the PR body's psql output.)
 */

import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  audit,
  createSession,
  deleteSession,
  getSession,
  insertRecommendations,
  listMessages,
  listSessions,
  serialiseSession,
  type Db,
} from './store.js';
import { parseModelResponse, stripPartialFence } from './recommendations.js';
import { RECOMMENDATION_FENCE } from './prompt.js';

/** Records every statement and returns canned rows. */
function fakeDb(rows: Record<string, unknown>[] = [{}]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Db = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values: values ?? [] });
      return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
    },
  };
  return { db, calls };
}

const SESSION_FIXTURE = {
  createdBy: 'someone@example.com',
  title: 'All corridors · 2026-06-10 17:00 PT',
  readingDate: '2026-06-10',
  bucketIdx: 68,
  localHour: 17,
  localTime: '17:00',
  corridor: 'ALL',
  snapshotKpis: { mean_speed_mph: 48.4 },
  modelEndpoint: 'databricks-claude-sonnet-5',
};

describe('createSession', () => {
  it('writes the anchor and serialises the KPI blob as jsonb', async () => {
    const { db, calls } = fakeDb([{ id: 'x', reading_date: '2026-06-10' }]);
    await createSession(db, SESSION_FIXTURE);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO app.advisor_sessions');
    // Order matters: a transposition here silently swaps local_hour and bucket_idx.
    expect(calls[0].values).toEqual([
      'someone@example.com',
      'All corridors · 2026-06-10 17:00 PT',
      '2026-06-10',
      68,
      17,
      '17:00',
      'ALL',
      '{"mean_speed_mph":48.4}',
      'databricks-claude-sonnet-5',
    ]);
    // Without the cast, Postgres rejects a text parameter for a jsonb column.
    expect(calls[0].text).toContain('$8::jsonb');
  });
});

describe('serialiseSession', () => {
  it('formats a pg Date from local parts, not toISOString', () => {
    // node-postgres parses DATE into a Date at local midnight. toISOString() would shift it
    // to the previous day for any negative UTC offset — i.e. for California.
    // Raw wire shape, exactly as node-postgres yields it — no assertion needed, because
    // serialiseSession declares its input as the raw row type.
    const out = serialiseSession({
      reading_date: new Date(2026, 5, 10),
      bucket_idx: '68',
      local_hour: '17',
    });
    expect(out.reading_date).toBe('2026-06-10');
    // Counts arrive as strings from pg for some numeric types.
    expect(out.bucket_idx).toBe(68);
    expect(out.local_hour).toBe(17);
  });

  it('defaults a null KPI blob to an object so the UI can index it', () => {
    const out = serialiseSession({ snapshot_kpis: null });
    expect(out.snapshot_kpis).toEqual({});
  });
});

describe('session scoping', () => {
  it('filters by created_by in the predicate, not after the fetch', async () => {
    const { db, calls } = fakeDb([]);
    const got = await getSession(db, 'sess-1', 'someone@example.com');
    // Another user's id must be indistinguishable from a nonexistent one.
    expect(calls[0].text).toContain('WHERE id = $1 AND created_by = $2');
    expect(calls[0].values).toEqual(['sess-1', 'someone@example.com']);
    expect(got).toBeNull();
  });

  it('scopes deletion by owner too', async () => {
    const { db, calls } = fakeDb([{}]);
    await deleteSession(db, 'sess-1', 'someone@example.com');
    expect(calls[0].text).toContain('created_by = $2');
  });

  it('lists only the caller’s sessions, newest activity first', async () => {
    const { db, calls } = fakeDb([{ message_count: '3' }]);
    const out = await listSessions(db, 'someone@example.com');
    expect(calls[0].text).toContain('WHERE s.created_by = $1');
    expect(calls[0].text).toContain('ORDER BY s.updated_at DESC');
    // System rows are evidence, not conversation — they must not inflate the count.
    expect(calls[0].text).toContain("role <> 'system'");
    expect(out[0].message_count).toBe(3);
  });
});

describe('listMessages', () => {
  it('returns the transcript in a deterministic order including system rows', async () => {
    const { db, calls } = fakeDb([]);
    await listMessages(db, 'sess-1');
    // The system row holds the snapshot brief and MUST be replayed to the model.
    expect(calls[0].text).not.toContain("role <> 'system'");
    // id breaks ties: two rows can share a created_at at ms resolution.
    expect(calls[0].text).toContain('ORDER BY created_at ASC, id ASC');
  });
});

describe('appendMessage', () => {
  it('persists usage, latency, finish reason and transport', async () => {
    const { db, calls } = fakeDb([{ id: 'm1' }]);
    await appendMessage(db, {
      sessionId: 'sess-1',
      role: 'assistant',
      content: 'text',
      modelEndpoint: 'databricks-claude-sonnet-5',
      promptTokens: 4418,
      completionTokens: 1600,
      latencyMs: 18219,
      finishReason: 'length',
      transport: 'stream',
      recommendations: [{ action_type: 'ramp_metering' }],
    });
    expect(calls[0].values).toEqual([
      'sess-1',
      'assistant',
      'text',
      'databricks-claude-sonnet-5',
      4418,
      1600,
      18219,
      'length',
      'stream',
      '[{"action_type":"ramp_metering"}]',
    ]);
    expect(calls[0].text).toContain('$10::jsonb');
  });

  it('stores SQL NULL, not the string "null", when there are no recommendations', async () => {
    const { db, calls } = fakeDb([{ id: 'm1' }]);
    await appendMessage(db, { sessionId: 's', role: 'user', content: 'hi' });
    // JSON.stringify(null) === "null", which would be a valid jsonb null — a different thing
    // from SQL NULL, and it would make `recommendations IS NULL` filters wrong.
    expect(calls[0].values[9]).toBeNull();
  });
});

describe('insertRecommendations', () => {
  const rec = {
    action_type: 'ramp_metering' as const,
    target_label: 'I-405 S',
    target_corridor: 'I-405',
    target_direction: 'S',
    expected_effect: 'Reduces delay',
    effect_direction: 'decrease' as const,
    magnitude: null,
    magnitude_unit: null,
    confidence: 'medium' as const,
    rationale: 'v/c 1.27',
    raw: {},
  };

  it('issues no statement for an empty list', async () => {
    const { db, calls } = fakeDb([]);
    expect(await insertRecommendations(db, { sessionId: 's', messageId: 'm', recommendations: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('inserts all rows atomically in one multi-row statement', async () => {
    const { db, calls } = fakeDb([{ id: 'r1' }, { id: 'r2' }]);
    await insertRecommendations(db, {
      sessionId: 's',
      messageId: 'm',
      recommendations: [rec, { ...rec, target_label: 'I-880 S' }],
    });
    // One round-trip, and a message can never get a partial set of recommendations.
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toHaveLength(28); // 2 rows x 14 columns
    expect(calls[0].text).toContain('$14::jsonb');
    expect(calls[0].text).toContain('$28::jsonb');
    // seq preserves display order without relying on insertion order.
    expect(calls[0].values[2]).toBe(0);
    expect(calls[0].values[16]).toBe(1);
  });
});

describe('audit', () => {
  it('writes to the shared audit table with a jsonb detail', async () => {
    const { db, calls } = fakeDb([{}]);
    await audit(db, {
      actor: 'someone@example.com',
      action: 'advisor.session.create',
      targetType: 'advisor_session',
      targetId: 'sess-1',
      detail: { bucket: 68 },
    });
    expect(calls[0].text).toContain('INSERT INTO app.audit');
    expect(calls[0].values).toEqual([
      'someone@example.com',
      'advisor.session.create',
      'advisor_session',
      'sess-1',
      '{"bucket":68}',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Recommendation parsing
// ---------------------------------------------------------------------------

const fence = (body: string) => `Prose answer here.\n\n\`\`\`${RECOMMENDATION_FENCE}\n${body}\n\`\`\``;

describe('parseModelResponse', () => {
  it('treats a response with no fence as pure prose, not an error', () => {
    const r = parseModelResponse('The snapshot shows free flow; no action is warranted.');
    expect(r.recommendations).toEqual([]);
    expect(r.malformed).toBe(false);
    expect(r.prose).toContain('free flow');
  });

  it('extracts recommendations and removes the block from the prose', () => {
    const r = parseModelResponse(
      fence(
        JSON.stringify([
          {
            action_type: 'ramp_metering',
            target: 'I-405 S',
            corridor: 'I-405',
            direction: 'S',
            expected_effect: 'Meters inflow',
            effect_direction: 'decrease',
            magnitude: null,
            confidence: 'medium',
            rationale: 'v/c 1.27',
          },
        ]),
      ),
    );
    expect(r.recommendations).toHaveLength(1);
    expect(r.recommendations[0].action_type).toBe('ramp_metering');
    expect(r.recommendations[0].target_corridor).toBe('I-405');
    expect(r.prose).toBe('Prose answer here.');
    expect(r.prose).not.toContain('ramp_metering');
  });

  it('coerces an unknown action to `other` and keeps the original string', () => {
    // The column is CHECK-constrained; an unmapped value must not fail the INSERT.
    const r = parseModelResponse(
      fence('[{"action_type":"summon_helicopters","target":"I-5 N","expected_effect":"x"}]'),
    );
    expect(r.recommendations[0].action_type).toBe('other');
    expect(r.recommendations[0].raw.action_type_raw).toBe('summon_helicopters');
  });

  it('accepts loose action spellings', () => {
    for (const v of ['Ramp Metering', 'ramp-metering', 'RAMP_METERING']) {
      const r = parseModelResponse(fence(`[{"action_type":"${v}","target":"I-5 N","expected_effect":"x"}]`));
      expect(r.recommendations[0].action_type).toBe('ramp_metering');
    }
  });

  it('salvages a stream truncated mid-object', () => {
    // Observed for real: a 1600-token cap cut the block mid-object. Recovering the complete
    // prefix beats discarding every recommendation.
    const truncated =
      'Prose.\n\n```' +
      RECOMMENDATION_FENCE +
      '\n[{"action_type":"ramp_metering","target":"I-405 S","expected_effect":"a"},' +
      '{"action_type":"lane_reversal","target":"I-880 S","expected_effect":"b"},' +
      '{"action_type":"signal_retiming","target":"I-6';
    const r = parseModelResponse(truncated);
    expect(r.recommendations).toHaveLength(2);
    expect(r.malformed).toBe(false);
  });

  it('tolerates a trailing comma', () => {
    const r = parseModelResponse(fence('[{"action_type":"ramp_metering","target":"I-5 N","expected_effect":"x"},]'));
    expect(r.recommendations).toHaveLength(1);
  });

  it('flags an unparseable block but still returns the prose', () => {
    const r = parseModelResponse(fence('this is not json at all {{{'));
    expect(r.malformed).toBe(true);
    expect(r.recommendations).toEqual([]);
    expect(r.prose).toBe('Prose answer here.');
  });

  it('never invents a value the model did not supply', () => {
    const r = parseModelResponse(fence('[{"action_type":"ramp_metering","target":"I-405 S","expected_effect":"x"}]'));
    const rec = r.recommendations[0];
    expect(rec.magnitude).toBeNull();
    expect(rec.magnitude_unit).toBeNull();
    expect(rec.confidence).toBeNull();
    expect(rec.effect_direction).toBeNull();
    expect(rec.rationale).toBeNull();
  });

  it('rejects out-of-vocabulary confidence and effect_direction', () => {
    const r = parseModelResponse(
      fence('[{"action_type":"ramp_metering","target":"I-5 N","expected_effect":"x","confidence":"very high","effect_direction":"sideways"}]'),
    );
    expect(r.recommendations[0].confidence).toBeNull();
    expect(r.recommendations[0].effect_direction).toBeNull();
  });

  it('infers corridor and direction from the target label when not given', () => {
    const r = parseModelResponse(
      fence('[{"action_type":"ramp_metering","target":"US-101 southbound","expected_effect":"x"}]'),
    );
    expect(r.recommendations[0].target_corridor).toBe('US-101');
    expect(r.recommendations[0].target_direction).toBe('S');
  });

  it('drops an entry carrying neither a target nor an effect', () => {
    const r = parseModelResponse(fence('[{"action_type":"ramp_metering"}]'));
    expect(r.recommendations).toEqual([]);
  });

  it('caps at the 5 the prompt asks for', () => {
    const many = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({
        action_type: 'ramp_metering',
        target: `I-${i} N`,
        expected_effect: 'x',
      })),
    );
    expect(parseModelResponse(fence(many)).recommendations).toHaveLength(5);
  });

  it('parses a numeric magnitude sent as a string', () => {
    const r = parseModelResponse(
      fence('[{"action_type":"ramp_metering","target":"I-5 N","expected_effect":"x","magnitude":"12","magnitude_unit":"percent"}]'),
    );
    expect(r.recommendations[0].magnitude).toBe(12);
  });
});

describe('stripPartialFence', () => {
  it('hides an in-progress block so raw JSON never flashes on screen', () => {
    const partial = 'Assessment text.\n\n```' + RECOMMENDATION_FENCE + '\n[{"action_ty';
    expect(stripPartialFence(partial)).toBe('Assessment text.');
  });

  it('leaves prose untouched when no fence has started', () => {
    expect(stripPartialFence('Just prose')).toBe('Just prose');
  });
});
