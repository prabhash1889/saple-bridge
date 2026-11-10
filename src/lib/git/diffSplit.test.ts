import { describe, it, expect } from 'vitest';
import { parseUnifiedDiffToSplitRows } from './diffSplit';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 const keep = 1;
-const removed = 2;
+const added = 2;
+const extra = 3;
 const tail = 4;
`;

describe('parseUnifiedDiffToSplitRows', () => {
  it('pairs deletions with the additions that replaced them', () => {
    const rows = parseUnifiedDiffToSplitRows(DIFF);

    // hunk header + 1 ctx + 2 paired change rows + 1 ctx
    expect(rows).toHaveLength(5);
    expect(rows[0].left.kind).toBe('meta');

    // Context spans both sides with independent numbering.
    expect(rows[1].left).toMatchObject({ num: 1, text: 'const keep = 1;', kind: 'ctx' });
    expect(rows[1].right).toMatchObject({ num: 1, kind: 'ctx' });

    // The removed line pairs against the first added line.
    expect(rows[2].left).toMatchObject({ num: 2, text: 'const removed = 2;', kind: 'del' });
    expect(rows[2].right).toMatchObject({ num: 2, text: 'const added = 2;', kind: 'add' });

    // Surplus addition pads the left side with an empty cell.
    expect(rows[3].left.kind).toBe('empty');
    expect(rows[3].right).toMatchObject({ num: 3, text: 'const extra = 3;', kind: 'add' });

    // Trailing context resumes with shifted new-side numbering.
    expect(rows[4].left).toMatchObject({ num: 3, text: 'const tail = 4;' });
    expect(rows[4].right).toMatchObject({ num: 4, text: 'const tail = 4;' });
  });

  it('ignores file headers and content before the first hunk', () => {
    const rows = parseUnifiedDiffToSplitRows('some noise\n--- a/x\n+++ b/x\n');
    expect(rows).toHaveLength(0);
  });

  it('handles pure-addition diffs (untracked files)', () => {
    const rows = parseUnifiedDiffToSplitRows('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    expect(rows).toHaveLength(3);
    expect(rows[1].left.kind).toBe('empty');
    expect(rows[1].right).toMatchObject({ num: 1, text: 'one', kind: 'add' });
    expect(rows[2].right).toMatchObject({ num: 2, text: 'two', kind: 'add' });
  });
});
