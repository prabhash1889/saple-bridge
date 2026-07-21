import { describe, it, expect } from 'vitest';
import { parsePlan, parseVerdict, diffPlan } from './swarmPlan';

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  mission: 'do a thing',
  ...over,
});

describe('parsePlan', () => {
  it('parses a well-formed plan with defaults filled in', () => {
    const plan = parsePlan({
      version: 2,
      acceptance: { command: 'npm test', description: 'suite green' },
      tasks: [task({ id: 'fe', mission: 'build fe', role: 'builder', review: true })],
    });
    expect(plan.version).toBe(2);
    expect(plan.acceptance).toEqual({ command: 'npm test', description: 'suite green' });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      id: 'fe',
      mission: 'build fe',
      role: 'builder',
      provider: 'auto',
      model: 'default',
      review: true,
      strategy: 'single',
      dependsOn: [],
    });
  });

  it('returns an empty plan for non-object / garbage input', () => {
    for (const bad of [null, undefined, 'nope', 42, []]) {
      expect(parsePlan(bad)).toEqual({ version: 2, acceptance: null, tasks: [] });
    }
  });

  it('defaults version to 2 and acceptance to null when missing or malformed', () => {
    expect(parsePlan({ tasks: [] })).toMatchObject({ version: 2, acceptance: null });
    expect(parsePlan({ version: 'two', acceptance: { description: 'no command' }, tasks: [] })).toMatchObject({
      version: 2,
      acceptance: null,
    });
    expect(parsePlan({ acceptance: { command: '  ' }, tasks: [] }).acceptance).toBeNull();
  });

  it('drops tasks missing id or mission', () => {
    const plan = parsePlan({
      tasks: [task({ id: '', mission: 'x' }), task({ id: 'y', mission: '' }), task({ id: 'z', mission: 'ok' })],
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(['z']);
  });

  it('trims id/mission and drops whitespace-only ones', () => {
    const plan = parsePlan({ tasks: [task({ id: '  a  ', mission: '  go  ' }), task({ id: '   ', mission: 'x' })] });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({ id: 'a', mission: 'go' });
  });

  it('drops unknown fields and coerces invalid enum values to defaults', () => {
    const plan = parsePlan({
      tasks: [task({ role: 'wizard', strategy: 'chaos', provider: 42, model: 7, review: 'yes', evil: 'x' })],
    });
    const t = plan.tasks[0] as unknown as Record<string, unknown>;
    expect(t.role).toBe('builder');
    expect(t.strategy).toBe('single');
    expect(t.provider).toBe('auto');
    expect(t.model).toBe('default');
    expect(t.review).toBe(false);
    expect('evil' in t).toBe(false);
  });

  it('keeps an explicit provider string and honors debate attempts', () => {
    const plan = parsePlan({
      tasks: [task({ provider: 'codex', strategy: 'debate', attempts: 4 })],
    });
    expect(plan.tasks[0].provider).toBe('codex');
    expect(plan.tasks[0].strategy).toBe('debate');
    expect(plan.tasks[0].attempts).toBe(4);
  });

  it('clamps debate attempts to a minimum of 2 and only sets attempts for debate', () => {
    expect(parsePlan({ tasks: [task({ strategy: 'debate', attempts: 1 })] }).tasks[0].attempts).toBe(2);
    expect(parsePlan({ tasks: [task({ strategy: 'debate' })] }).tasks[0].attempts).toBe(2);
    expect(parsePlan({ tasks: [task({ strategy: 'single', attempts: 5 })] }).tasks[0].attempts).toBeUndefined();
  });

  it('collapses duplicate ids to the first occurrence', () => {
    const plan = parsePlan({
      tasks: [task({ id: 'dup', mission: 'first' }), task({ id: 'dup', mission: 'second' })],
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].mission).toBe('first');
  });

  it('filters non-string and unknown dependency ids', () => {
    const plan = parsePlan({
      tasks: [task({ id: 'a', mission: 'a' }), task({ id: 'b', mission: 'b', dependsOn: ['a', 'ghost', 42, null] })],
    });
    expect(plan.tasks.find((t) => t.id === 'b')?.dependsOn).toEqual(['a']);
  });

  it('drops self-dependencies (trivial cycle) without dropping the task', () => {
    const plan = parsePlan({ tasks: [task({ id: 'a', mission: 'a', dependsOn: ['a'] })] });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].dependsOn).toEqual([]);
  });

  it('drops tasks in a dependency cycle and anything transitively behind them', () => {
    const plan = parsePlan({
      tasks: [
        task({ id: 'a', mission: 'a', dependsOn: ['b'] }),
        task({ id: 'b', mission: 'b', dependsOn: ['a'] }),
        task({ id: 'c', mission: 'c', dependsOn: ['a'] }), // stuck behind the cycle
        task({ id: 'ok', mission: 'ok' }),
      ],
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(['ok']);
  });

  it('keeps a valid acyclic chain in input order', () => {
    const plan = parsePlan({
      tasks: [
        task({ id: 'a', mission: 'a' }),
        task({ id: 'b', mission: 'b', dependsOn: ['a'] }),
        task({ id: 'c', mission: 'c', dependsOn: ['b'] }),
      ],
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not choke on prototype-pollution-shaped ids', () => {
    const plan = parsePlan({
      tasks: [
        task({ id: '__proto__', mission: 'evil' }),
        task({ id: 'constructor', mission: 'evil2', dependsOn: ['__proto__'] }),
      ],
    });
    expect(plan.tasks.map((t) => t.id).sort()).toEqual(['__proto__', 'constructor']);
    // The real prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a non-array tasks field', () => {
    expect(parsePlan({ tasks: 'not-an-array' }).tasks).toEqual([]);
  });
});

describe('parseVerdict', () => {
  it('accepts approve and reject with optional feedback', () => {
    expect(parseVerdict({ taskId: 'fe', verdict: 'approve' })).toEqual({ taskId: 'fe', verdict: 'approve' });
    expect(parseVerdict({ taskId: 'fe', verdict: 'reject', feedback: 'move to keychain' })).toEqual({
      taskId: 'fe',
      verdict: 'reject',
      feedback: 'move to keychain',
    });
  });

  it('trims taskId and drops non-string feedback', () => {
    expect(parseVerdict({ taskId: '  fe  ', verdict: 'approve', feedback: 42 })).toEqual({
      taskId: 'fe',
      verdict: 'approve',
    });
  });

  it('returns null for any non-approve/reject verdict', () => {
    for (const bad of ['maybe', 'APPROVE', '', 1, null, undefined]) {
      expect(parseVerdict({ taskId: 'fe', verdict: bad })).toBeNull();
    }
  });

  it('returns null when taskId is missing or empty', () => {
    expect(parseVerdict({ verdict: 'approve' })).toBeNull();
    expect(parseVerdict({ taskId: '   ', verdict: 'approve' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    for (const bad of [null, undefined, 'approve', 7, []]) {
      expect(parseVerdict(bad)).toBeNull();
    }
  });
});

describe('diffPlan', () => {
  const plan = parsePlan({
    tasks: [
      task({ id: 'a', mission: 'a' }),
      task({ id: 'b', mission: 'b', dependsOn: ['a'] }),
      task({ id: 'c', mission: 'c', dependsOn: ['b'] }),
    ],
  });

  it('returns every task when nothing has been applied', () => {
    expect(diffPlan([], plan).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns only tasks whose id is not already applied', () => {
    expect(diffPlan(['a', 'b'], plan).map((t) => t.id)).toEqual(['c']);
  });

  it('returns nothing when the full plan is re-emitted unchanged', () => {
    expect(diffPlan(['a', 'b', 'c'], plan)).toEqual([]);
  });

  it('keeps a new task that depends on an already-applied task', () => {
    expect(diffPlan(['a'], plan).map((t) => t.id)).toEqual(['b', 'c']);
    // 'b' depends on the applied 'a' — still legitimately new.
    expect(diffPlan(['a'], plan)[0].dependsOn).toEqual(['a']);
  });
});
